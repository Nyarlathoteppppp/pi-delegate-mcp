#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";
import { PiWorker, READ_ONLY_TOOLS, modelScope, preflight, resolveModel, scopedModels } from "./worker.mjs";
import { cleanup, publish } from "./state.mjs";

/** Single source of truth for the version the MCP handshake reports. */
const { name: PKG_NAME, version: PKG_VERSION } = createRequire(import.meta.url)("../package.json");

/**
 * Opt-in escape hatches. Without one, the delegate can never write, edit, or run shell.
 *
 * PI_DELEGATE_ALLOW_TOOLS is a comma list of extra tool names to permit.
 * PI_DELEGATE_ALLOW_WRITE=1 permits everything.
 *
 * Neither is a sandbox. pi has no permission system, so granting `bash` grants
 * every capability the user running this server has, writes included.
 */
const ALLOW_ALL = process.env.PI_DELEGATE_ALLOW_WRITE === "1";
const ALLOW_EXTRA = (process.env.PI_DELEGATE_ALLOW_TOOLS || "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const DEFAULT_MODEL = process.env.PI_DELEGATE_MODEL || undefined;
const PROGRESS_MS = Number(process.env.PI_DELEGATE_PROGRESS_MS || 15000);

const sessions = new Map();
/** Finished sessions stay readable for later review; oldest are evicted first. */
const HISTORY_LIMIT = Number(process.env.PI_DELEGATE_HISTORY || 50);
/** Ceiling on one `spawn_batch` call. A fan-out this wide is usually a planning mistake. */
const BATCH_MAX = Number(process.env.PI_DELEGATE_BATCH_MAX || 10);
/** Above this, `init` summarises by provider instead of dumping every ref. */
const LIST_CAP = Number(process.env.PI_DELEGATE_LIST_CAP || 60);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function claimId(id) {
  if (id === undefined) return undefined;
  if (!ID_PATTERN.test(id))
    throw new Error(
      `Invalid id "${id}". Use 1-64 chars: letters, digits, then . _ : - are allowed. ` +
        `Something like "search-audit-01" or "review:engine.go".`,
    );
  if (sessions.has(id)) throw new Error(`Session id "${id}" is already in use. Pick another or call abort/forget first.`);
  return id;
}

function evictHistory() {
  const done = [...sessions.values()].filter((w) => w.state !== "running" && w.state !== "starting");
  while (sessions.size > HISTORY_LIMIT && done.length) {
    const oldest = done.shift();
    oldest.dispose();
    sessions.delete(oldest.id);
  }
}

function must(id) {
  const w = sessions.get(id);
  if (!w) throw new Error(`Unknown sessionId: ${id}`);
  return w;
}

const PERMITTED = new Set([...READ_ONLY_TOOLS, ...ALLOW_EXTRA]);

function pickTools(requested) {
  if (!requested?.length) return READ_ONLY_TOOLS;
  if (ALLOW_ALL) return requested;
  const denied = requested.filter((t) => !PERMITTED.has(t));
  if (denied.length)
    throw new Error(
      `Tools [${denied.join(", ")}] are blocked. Permitted here: ${[...PERMITTED].join(", ")}. ` +
        `Add them to PI_DELEGATE_ALLOW_TOOLS (comma list) in this server's env, or set ` +
        `PI_DELEGATE_ALLOW_WRITE=1 to permit everything. Note that granting bash grants writes too.`,
    );
  return requested;
}

async function launch({ prompt, model, cwd, tools, extensions, id, label }) {
  const worker = new PiWorker({
    id: claimId(id),
    label,
    cwd: cwd || process.cwd(),
    model: model || DEFAULT_MODEL,
    tools: pickTools(tools),
    extensions: extensions ?? false,
  });
  worker.onChange = () => publish(sessions.values());
  sessions.set(worker.id, worker);
  try {
    await worker.start(prompt);
  } catch (e) {
    sessions.delete(worker.id);
    publish(sessions.values());
    throw e;
  }
  evictHistory();
  publish(sessions.values());
  return worker;
}

const json = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

let initialised = false;

/** Every tool but `init` refuses until the caller has read the operating instructions. */
function requireInit() {
  if (!initialised)
    throw new Error(
      "Call `init` first. It reports the models available here, the tools this server permits, " +
        "and how to drive a delegate. One call, then everything else unlocks.",
    );
}

const server = new McpServer(
  { name: PKG_NAME, version: PKG_VERSION },
  {
    capabilities: { tools: {} },
    instructions:
      "Delegates work to the pi coding agent, keeping the delegate's context out of your own. " +
      "CRITICAL: call `init` before anything else. The other tools refuse until you do. " +
      "It reports which models are reachable, which tools are permitted, and the recipes for " +
      "spawning, steering, and answering a delegate.",
  },
);

server.registerTool(
  "init",
  {
    description:
      "READ THIS FIRST. Reports what this server can reach and how to drive it: permitted tools, " +
      "the default model, models available per provider, and the recipes for delegating. " +
      "Every other tool refuses until this has been called once.",
    inputSchema: {
      models: z.string().optional().describe('Substring to filter the model list, e.g. "deepseek"'),
      cwd: z
        .string()
        .optional()
        .describe("Repository you intend to delegate in; picks up its project-local pi model scope"),
    },
  },
  async ({ models: filter, cwd }) => {
    // Throws if pi is missing, unauthenticated, or scoped down to nothing. `initialised`
    // stays false in that case, so the other tools remain shut rather than half-working.
    const health = await preflight(cwd);
    initialised = true;
    const scope = modelScope(cwd);
    const all = (await scopedModels(cwd)).map((m) => m.ref);

    const hits = filter ? all.filter((m) => m.toLowerCase().includes(filter.toLowerCase())) : all;

    const byProvider = {};
    for (const id of hits) {
      const provider = id.slice(0, id.indexOf("/"));
      byProvider[provider] = (byProvider[provider] ?? 0) + 1;
    }

    return json({
      // Deliberately does not report pi's total authenticated model count. Advertising 396
      // models when 15 are in scope invites the caller to pick one that is a hard error.
      pi: { ok: true, usableModels: health.usable.length },
      what:
        "pi-delegate-mcp hands a task to the pi coding agent. The delegate reads files and reasons " +
        "on its own budget, then returns a result. Its context never enters yours.",

      permissions: {
        toolsAllowedHere: ALLOW_ALL ? "any (PI_DELEGATE_ALLOW_WRITE=1)" : [...PERMITTED],
        defaultIfYouOmitTools: READ_ONLY_TOOLS,
        warning:
          "This is not a sandbox. pi has no permission system, so a delegate holding `bash` can " +
          "write and delete files whatever its tool list says. Your prompt is the only other guardrail.",
      },

      models: {
        defaultWhenYouOmitModel: DEFAULT_MODEL ?? "(pi's own configured default)",
        format: 'Pass "provider/modelId". An unresolvable name is a hard error, never a silent fallback.',
        scoped: scope
          ? "Only the models below may be used. Anything else is a hard error."
          : "pi has no enabledModels set, so every configured model is usable.",
        total: hits.length,
        // A scoped set is small by construction, so it is listed in full, so the caller never
        // has to guess whether a name is allowed. Only an unscoped pi can be large
        // enough to flood a context, and that is summarised rather than truncated silently.
        ...(hits.length > LIST_CAP
          ? {
              byProvider,
              note: `${hits.length} models is too many to list. Narrow it with the \`models\` argument, ` +
                "or set pi's enabledModels so this server only offers what you actually intend to use.",
            }
          : { available: hits }),
      },

      howToDelegate: [
        "1. `spawn` for real work. It returns a sessionId immediately, nothing blocks. Give it your own " +
          '`id` and a `label` so you can trace it later, e.g. id: "search-audit-01".',
        "2. `status` to poll. Read `state`, `turns`, and `toolCalls` (the ordered tool trace). " +
          "Add `verbose: true` to see tool results.",
        "3. `steer` if it goes the wrong way. The message lands after its current tool call, " +
          "before the next model call. Cheaper than aborting and restarting.",
        "4. `answer` when `status` shows a non-empty `questions` array. The delegate is blocked until you do.",
        "5. `sessions` lists everything including finished runs; `forget` drops one.",
        "`run` blocks until done. Only use it for questions that finish in under a minute.",
      ],

      gotchas: [
        "Slow models plus many turns means minutes, not seconds. Prefer `spawn` over `run`.",
        "The delegate cannot see your conversation. Put every fact it needs into `prompt`.",
        "It reads AGENTS.md and CLAUDE.md from `cwd`, so point `cwd` at the right repository.",
        "pi extensions are off by default because they add startup cost and can misbehave. " +
          "Pass `extensions: true` only if the delegate needs them.",
      ],

      limits: {
        historyKept: HISTORY_LIMIT,
        traceArgsChars: Number(process.env.PI_DELEGATE_TRACE_ARGS || 400),
        traceResultChars: Number(process.env.PI_DELEGATE_TRACE_RESULT || 600),
      },
    });
  },
);

/** Register a tool that is unavailable until `init` has been called. */
const tool = (name, meta, handler) =>
  server.registerTool(name, meta, async (...args) => {
    requireInit();
    return handler(...args);
  });

const spawnShape = {
  prompt: z.string().describe("The task for the pi agent"),
  model: z.string().optional().describe('Model as "provider/modelId", e.g. "openrouter/stealth/ox-alpha"'),
  cwd: z.string().optional().describe("Working directory for the agent"),
  id: z
    .string()
    .optional()
    .describe(
      'Your own session id for traceability, e.g. "search-audit-01". 1-64 chars of [A-Za-z0-9._:-], ' +
        "must start alphanumeric, must not already be in use. Defaults to a UUID.",
    ),
  label: z.string().optional().describe("Free-text note shown in `sessions`, e.g. what this delegate is for"),
  tools: z
    .array(z.string())
    .optional()
    .describe(
      `Tool allowlist for this delegate. Default: ${READ_ONLY_TOOLS.join(", ")}. ` +
        `Permitted on this server: ${ALLOW_ALL ? "any" : [...PERMITTED].join(", ")}.`,
    ),
  extensions: z
    .boolean()
    .optional()
    .describe("Load pi extensions for this delegate. Off by default; they add startup cost and can misbehave."),
};

tool(
  "spawn",
  {
    description:
      "Delegate a task to a pi agent running in the background. Returns a sessionId immediately, so " +
      "nothing blocks. Poll with `status`, redirect with `steer`, answer its questions with `answer`. " +
      "Use this for anything that might take more than a minute.",
    inputSchema: spawnShape,
  },
  async (args) => {
    const w = await launch(args);
    return json({ sessionId: w.id, label: w.label, state: w.state, model: w.model, activeTools: w.activeTools });
  },
);

const taskShape = z.object({
  prompt: z.string().describe("The task for this delegate"),
  id: z.string().optional().describe("Session id for this task. Defaults to `idPrefix`-NN, or a UUID."),
  label: z.string().optional().describe("Free-text note for this task"),
  model: z.string().optional().describe("Overrides the batch `model` for this task alone"),
  cwd: z.string().optional().describe("Overrides the batch `cwd` for this task alone"),
  tools: z.array(z.string()).optional().describe("Overrides the batch `tools` for this task alone"),
  extensions: z.boolean().optional(),
});

tool(
  "spawn_batch",
  {
    description:
      "Fan out several delegates in one call. Each task inherits the batch-level model, cwd, tools " +
      "and extensions unless it overrides them. The whole batch is validated before any delegate " +
      "starts, so a bad model name or a duplicate id fails everything instead of leaving half a " +
      "fan-out running. Poll the result with `sessions`, which reports all of them at once, rather " +
      "than one `status` per delegate.",
    inputSchema: {
      tasks: z.array(taskShape).min(1).max(BATCH_MAX).describe(`1 to ${BATCH_MAX} delegates to start`),
      model: z.string().optional().describe("Default model for every task in this batch"),
      cwd: z.string().optional().describe("Default working directory for every task in this batch"),
      tools: z.array(z.string()).optional().describe("Default tool allowlist for every task in this batch"),
      extensions: z.boolean().optional().describe("Default extensions setting for every task in this batch"),
      idPrefix: z
        .string()
        .optional()
        .describe('Names the tasks `<prefix>-01`, `<prefix>-02`, ... e.g. "audit" gives "audit-01"'),
    },
  },
  async ({ tasks, model, cwd, tools, extensions, idPrefix }) => {
    const width = String(tasks.length).length;
    const merged = tasks.map((t, i) => ({
      prompt: t.prompt,
      label: t.label,
      model: t.model ?? model,
      cwd: t.cwd ?? cwd,
      tools: t.tools ?? tools,
      extensions: t.extensions ?? extensions,
      id: t.id ?? (idPrefix ? `${idPrefix}-${String(i + 1).padStart(Math.max(width, 2), "0")}` : undefined),
    }));

    // Validate the batch up front. Every check here is cheap and deterministic, and a half-started
    // fan-out is the worst outcome: you pay for the delegates that launched and still have to work
    // out which ones did not.
    const seen = new Set();
    for (const [i, t] of merged.entries()) {
      if (t.id) {
        if (seen.has(t.id))
          throw new Error(`tasks[${i}] reuses id "${t.id}" from earlier in the same batch. Ids must be unique.`);
        seen.add(t.id);
        claimId(t.id);
      }
      try {
        pickTools(t.tools);
        await resolveModel(t.model || DEFAULT_MODEL, t.cwd || process.cwd());
      } catch (e) {
        throw new Error(`tasks[${i}]${t.id ? ` (${t.id})` : ""}: ${e?.message ?? e}`);
      }
    }

    const started = [];
    const failures = [];
    await Promise.all(
      merged.map(async (t, index) => {
        try {
          const w = await launch(t);
          started.push({ index, sessionId: w.id, label: w.label, state: w.state, model: w.model });
        } catch (e) {
          failures.push({ index, id: t.id, error: e?.message ?? String(e) });
        }
      }),
    );
    const byIndex = (a, b) => a.index - b.index;
    started.sort(byIndex);
    failures.sort(byIndex);

    return json({
      requested: merged.length,
      started: started.length,
      sessions: started,
      // Only reachable if a session dies during construction, after validation passed.
      ...(failures.length ? { failed: failures.length, failures } : {}),
      next: "Poll with `sessions` (one call covers the whole batch). `steer` and `abort` stay per session.",
    });
  },
);

tool(
  "run",
  {
    description:
      "Delegate a task to a pi agent and wait for the final answer. Blocks until done. " +
      "Prefer `spawn` for long work; this is for quick questions.",
    inputSchema: spawnShape,
  },
  async (args, extra) => {
    const w = await launch(args);
    // Progress notifications reset the MCP request timeout, which defaults to 60s.
    const token = extra?._meta?.progressToken;
    const ticker = token
      ? setInterval(() => {
          extra
            ?.sendNotification?.({
              method: "notifications/progress",
              params: { progressToken: token, progress: w.turns, message: `${w.state}, turn ${w.turns}` },
            })
            ?.catch(() => {});
        }, PROGRESS_MS)
      : undefined;
    try {
      await w.run;
    } finally {
      clearInterval(ticker);
    }
    const snap = w.snapshot();
    evictHistory();
    return json(snap);
  },
);

tool(
  "status",
  {
    description:
      "Check a background pi session. Returns state, turn count, tools used, latest text, and any " +
      "pending questions the agent is waiting on. A non-empty `questions` array means it is blocked " +
      "until you call `answer`. `toolCalls` traces every tool the delegate ran, in order.",
    inputSchema: {
      sessionId: z.string(),
      verbose: z.boolean().optional().describe("Include tool results and call ids in the trace"),
    },
  },
  async ({ sessionId, verbose }) => json(must(sessionId).snapshot({ verbose })),
);

tool(
  "steer",
  {
    description:
      "Redirect a running pi agent mid-task. The message lands after its current tool call finishes, " +
      "before the next model call. Use this instead of aborting when the agent is going the wrong way.",
    inputSchema: { sessionId: z.string(), message: z.string() },
  },
  async ({ sessionId, message }) => json(await must(sessionId).steer(message)),
);

tool(
  "answer",
  {
    description: "Answer a question raised by a pi agent. Get `requestId` from `status`.",
    inputSchema: {
      sessionId: z.string(),
      requestId: z.string(),
      value: z.union([z.string(), z.boolean()]).describe("Chosen option, text, or boolean for a confirm"),
    },
  },
  async ({ sessionId, requestId, value }) => json(must(sessionId).answer(requestId, value)),
);

tool(
  "abort",
  {
    description: "Stop a running pi session. Partial output stays readable via `status`.",
    inputSchema: { sessionId: z.string() },
  },
  async ({ sessionId }) => json(await must(sessionId).abort()),
);

tool(
  "models",
  {
    description:
      "List models this delegate may use: pi's own scoped set plus any custom provider. " +
      "Use to pick a `model` value.",
    inputSchema: {
      filter: z.string().optional(),
      cwd: z.string().optional().describe("Picks up a project-local pi model scope"),
    },
  },
  async ({ filter, cwd }) => {
    const all = (await scopedModels(cwd)).map((m) => m.ref);
    const hits = filter ? all.filter((s) => s.toLowerCase().includes(filter.toLowerCase())) : all;
    return json({ count: hits.length, scoped: Boolean(modelScope(cwd)), models: hits.slice(0, 200) });
  },
);

tool(
  "sessions",
  {
    description:
      "List pi sessions held by this server, running and finished. Finished ones stay readable for " +
      `review until evicted (keeps the newest ${HISTORY_LIMIT}).`,
    inputSchema: {
      state: z.string().optional().describe("Filter by state: starting, running, done, aborted, error"),
      verbose: z.boolean().optional().describe("Include full text and tool calls"),
    },
  },
  async ({ state, verbose }) => {
    let list = [...sessions.values()].map((w) => w.snapshot());
    if (state) list = list.filter((s) => s.state === state);
    if (!verbose)
      list = list.map(({ sessionId, label, state, model, turns, startedAt, finishedAt, questions }) => ({
        sessionId, label, state, model, turns, startedAt, finishedAt,
        pendingQuestions: questions.length,
      }));
    return json({ count: list.length, sessions: list });
  },
);

tool(
  "forget",
  {
    description: "Drop a finished session from the review history, freeing its id for reuse.",
    inputSchema: { sessionId: z.string() },
  },
  async ({ sessionId }) => {
    const w = must(sessionId);
    if (w.state === "running" || w.state === "starting")
      throw new Error(`Session ${sessionId} is still ${w.state}. Call abort first.`);
    w.dispose();
    sessions.delete(sessionId);
    return json({ forgotten: sessionId });
  },
);

// A misbehaving pi extension can fire a timer after its session is disposed and
// throw from outside every await. Without this the whole server dies with it.
process.on("uncaughtException", (err) => {
  process.stderr.write(`[pi-delegate] uncaught: ${err?.stack ?? err}\n`);
});
process.on("unhandledRejection", (err) => {
  process.stderr.write(`[pi-delegate] unhandled rejection: ${err?.stack ?? err}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));
process.on("exit", cleanup);

// An MCP host that dies without closing the transport would otherwise leave this process
// running forever, holding sessions and a state file nobody reads.
process.stdin.on("close", () => process.exit(0));
const HOST_PID = process.ppid;
setInterval(() => {
  try {
    process.kill(HOST_PID, 0);
  } catch {
    process.exit(0);
  }
}, 30_000).unref();

await server.connect(new StdioServerTransport());
