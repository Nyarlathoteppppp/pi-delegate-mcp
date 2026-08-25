import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

export const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

const IGNORE_SCOPE = process.env.PI_DELEGATE_IGNORE_SCOPE === "1";

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * The delegate may only use models pi itself has scoped, plus anything served by a
 * custom provider from models.json, since those are declared by hand and are the point of
 * having a custom provider at all.
 *
 * Mirrors pi's settings precedence: project `<cwd>/.pi/settings.json` overrides global.
 * An empty or missing enabledModels means no scoping, matching pi's own no-op default.
 */
export function modelScope(cwd) {
  if (IGNORE_SCOPE) return undefined;
  const global = readJson(join(AGENT_DIR, "settings.json"))?.enabledModels;
  const local = cwd ? readJson(join(cwd, ".pi", "settings.json"))?.enabledModels : undefined;
  const enabled = local ?? global;
  if (!Array.isArray(enabled) || enabled.length === 0) return undefined;

  const customProviders = Object.keys(readJson(join(AGENT_DIR, "models.json"))?.providers ?? {});
  return { enabled: new Set(enabled), customProviders: new Set(customProviders) };
}

export function inScope(scope, provider, id) {
  if (!scope) return true;
  return scope.customProviders.has(provider) || scope.enabled.has(`${provider}/${id}`);
}

/**
 * Models the delegate can actually use: in scope AND backed by a provider that is
 * authenticated. A scoped model with no credentials is not usable, so it is not offered.
 */
export async function scopedModels(cwd) {
  const scope = modelScope(cwd);
  const rt = await getRuntime();
  const available = await rt.getAvailable();
  return available
    .map((m) => ({ provider: m.provider, id: m.id, ref: `${m.provider}/${m.id}` }))
    .filter((m) => inScope(scope, m.provider, m.id));
}

/**
 * Refuse to operate at all when pi is absent or unusable. A delegate server that
 * silently degrades is worse than one that will not start.
 */
export async function preflight(cwd) {
  if (!existsSync(AGENT_DIR))
    throw new Error(
      `pi is not configured: ${AGENT_DIR} does not exist. Install pi ` +
        `(npm i -g @earendil-works/pi-coding-agent), run \`pi\` once, and \`/login\` a provider.`,
    );

  const rt = await getRuntime();
  const runtimeError = rt.getError();
  if (runtimeError) throw new Error(`pi's model runtime failed to load: ${runtimeError}`);

  const available = await rt.getAvailable();
  if (available.length === 0)
    throw new Error(
      `pi has no authenticated provider. Run \`pi\` and \`/login\`, or put an API key in ` +
        `${join(AGENT_DIR, "auth.json")}. Environment variables are unreliable here because MCP ` +
        `hosts launch servers with a stripped environment.`,
    );

  const usable = await scopedModels(cwd);
  if (usable.length === 0) {
    const scope = modelScope(cwd);
    throw new Error(
      scope
        ? `No usable model. pi's enabledModels scope [${[...scope.enabled].join(", ")}] does not ` +
          `intersect any authenticated provider. Widen it via pi's /scoped-models, log in to the ` +
          `matching provider, or set PI_DELEGATE_IGNORE_SCOPE=1.`
        : "No usable model: pi reports authenticated providers but none carry a usable model.",
    );
  }
  return { available: available.length, usable: usable.map((m) => m.ref) };
}

let runtimePromise;
export function getRuntime() {
  runtimePromise ??= ModelRuntime.create();
  return runtimePromise;
}

/**
 * Resolve "provider/modelId" -> Model. Splits on the FIRST slash so
 * "openrouter/stealth/ox-alpha" yields provider=openrouter, id=stealth/ox-alpha.
 *
 * Throws on a miss. pi silently falls back to the default model when handed
 * `undefined`, which is how you end up billing a model you never asked for.
 */
export async function resolveModel(spec, cwd) {
  if (!spec) return undefined;
  const rt = await getRuntime();
  const slash = spec.indexOf("/");
  let model;
  if (slash > 0) model = rt.getModel(spec.slice(0, slash), spec.slice(slash + 1));
  model ??= rt.getModels().find((m) => m.id === spec);

  if (!model)
    throw new Error(
      `Model not found: ${spec}. Use "provider/modelId", e.g. "openrouter/stealth/ox-alpha". ` +
        `Call the "models" tool to list what is available.`,
    );

  const scope = modelScope(cwd);
  if (!inScope(scope, model.provider, model.id)) {
    const allowed = (await scopedModels(cwd)).map((m) => m.ref);
    throw new Error(
      `Model ${model.provider}/${model.id} is out of scope. Allowed here: ${allowed.join(", ")}. ` +
        `Widen it in pi's own settings (enabledModels, via /scoped-models) or set ` +
        `PI_DELEGATE_IGNORE_SCOPE=1 on this server.`,
    );
  }
  return model;
}

/** A pending question raised by a pi extension, waiting for an answer. */
class Question {
  constructor(kind, title, detail, options) {
    this.id = randomUUID().slice(0, 8);
    this.kind = kind;
    this.title = title;
    this.detail = detail;
    this.options = options;
    this.asked = new Date().toISOString();
    this.promise = new Promise((resolve) => (this.resolve = resolve));
  }
  toJSON() {
    const { id, kind, title, detail, options, asked } = this;
    return { id, kind, title, detail, options, asked };
  }
}

const TRACE_ARGS = Number(process.env.PI_DELEGATE_TRACE_ARGS || 400);
const TRACE_RESULT = Number(process.env.PI_DELEGATE_TRACE_RESULT || 600);

/** Tool results can be an entire file. Keep a readable head, record what was dropped. */
function clip(value, limit) {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return undefined;
  return text.length <= limit ? text : `${text.slice(0, limit)}… [+${text.length - limit} chars]`;
}

/** pi returns tool output as {content:[{type:"text",text}]}. Flatten for the trace. */
function flatten(result) {
  const parts = result?.content;
  if (!Array.isArray(parts)) return clip(result, TRACE_RESULT);
  return clip(parts.map((c) => c?.text ?? `[${c?.type ?? "?"}]`).join("\n"), TRACE_RESULT);
}

const NOOP = () => {};
const noopUnsub = () => NOOP;

/**
 * Extensions that decorate output reach for ui.theme.fg()/bg()/etc. There is no
 * terminal here, so hand them an identity palette rather than let a statusline
 * extension take down the whole bind.
 */
const PLAIN_THEME = new Proxy(
  {},
  { get: () => (value) => (typeof value === "string" ? value : "") },
);

export class PiWorker {
  constructor({ id, label, cwd, model, tools, extensions = false }) {
    this.extensionsEnabled = extensions;
    this.label = label;
    this.id = id ?? randomUUID();
    this.cwd = cwd;
    this.modelSpec = model;
    this.toolNames = tools;
    this.state = "starting";
    this.turns = 0;
    this.lastText = "";
    this.toolCalls = [];
    this.openCalls = new Map();
    this.notices = [];
    this.questions = new Map();
    this.error = undefined;
    this.startedAt = new Date().toISOString();
  }

  /** Extension UI: queue dialogs instead of blocking on a terminal nobody is watching. */
  #uiContext() {
    const ask = (kind, title, detail, options) => {
      const q = new Question(kind, title, detail, options);
      this.questions.set(q.id, q);
      this.onChange?.();
      return q.promise;
    };
    return new Proxy(
      {
        select: (title, options) => ask("select", title, undefined, options),
        confirm: (title, message) => ask("confirm", title, message),
        input: (title, placeholder) => ask("input", title, placeholder),
        notify: (message, type = "info") => {
          this.notices.push({ type, message, at: new Date().toISOString() });
        },
        theme: PLAIN_THEME,
        custom: async () => undefined,
        onTerminalInput: noopUnsub,
        getEditorText: () => "",
        getToolsExpanded: () => false,
        getAllThemes: () => [],
        getTheme: () => undefined,
        setTheme: () => ({ success: false, error: "no TUI" }),
      },
      { get: (t, p) => (p in t ? t[p] : NOOP) },
    );
  }

  async start(prompt) {
    const model = await resolveModel(this.modelSpec, this.cwd);
    // Third-party pi extensions start timers and sockets that outlive dispose()
    // and then throw against a stale ctx. A delegate does not need them.
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: AGENT_DIR,
      noExtensions: !this.extensionsEnabled,
    });
    // The loader is lazy: getExtensions() returns nothing until reload() has run, so without
    // this `extensions: true` silently loads zero extensions and costs startup time for nothing.
    // A failure here is not fatal, since a delegate with no extensions still works.
    if (this.extensionsEnabled) {
      try {
        await resourceLoader.reload();
      } catch (e) {
        this.notices.push({ type: "warning", message: `extensions failed to load: ${e?.message ?? e}`, at: new Date().toISOString() });
      }
    }
    const { session } = await createAgentSession({
      cwd: this.cwd,
      modelRuntime: await getRuntime(),
      model,
      sessionManager: SessionManager.inMemory(),
      tools: this.toolNames,
      resourceLoader,
    });
    this.session = session;
    this.model = model ? `${model.provider}/${model.id}` : "(pi default)";
    this.activeTools = session.getActiveToolNames();

    this.unsubscribe = session.subscribe((ev) => this.#onEvent(ev));
    try {
      await session.bindExtensions({ uiContext: this.#uiContext(), mode: "rpc" });
    } catch {
      // Extensions are optional. A binding failure must not sink the run.
    }

    this.state = "running";
    this.run = session
      .prompt(prompt)
      .then(() => session.waitForIdle())
      .then(() => {
        this.state = this.state === "aborted" ? "aborted" : "done";
      })
      .catch((e) => {
        this.state = "error";
        this.error = e?.message ?? String(e);
      })
      .finally(() => {
        this.finishedAt = new Date().toISOString();
        for (const q of this.questions.values()) q.resolve(undefined);
        this.onChange?.();
      });
    return this;
  }

  #onEvent(ev) {
    switch (ev.type) {
      case "turn_start":
        this.turns++;
        this.onChange?.();
        break;
      case "tool_execution_start": {
        const call = {
          seq: this.toolCalls.length + 1,
          id: ev.toolCallId,
          name: ev.toolName,
          args: clip(ev.args, TRACE_ARGS),
          state: "running",
          startedAt: Date.now(),
        };
        this.toolCalls.push(call);
        if (ev.toolCallId) this.openCalls.set(ev.toolCallId, call);
        break;
      }
      case "tool_execution_end": {
        const call =
          this.openCalls.get(ev.toolCallId) ??
          [...this.toolCalls].reverse().find((c) => c.state === "running" && c.name === ev.toolName);
        if (call) {
          call.state = ev.isError ? "error" : "ok";
          call.ms = Date.now() - call.startedAt;
          call.result = flatten(ev.result);
          delete call.startedAt;
          this.openCalls.delete(ev.toolCallId);
        }
        break;
      }
      case "message_update":
        if (ev.assistantMessageEvent?.type === "text_end")
          this.lastText = ev.assistantMessageEvent.content ?? this.lastText;
        break;
    }
    this.onEvent?.(ev);
  }

  pendingQuestions() {
    return [...this.questions.values()].map((q) => q.toJSON());
  }

  answer(requestId, value) {
    const q = this.questions.get(requestId);
    if (!q) throw new Error(`No pending question ${requestId} on session ${this.id}`);
    this.questions.delete(requestId);
    q.resolve(q.kind === "confirm" ? value === true || value === "true" : value);
    this.onChange?.();
    return { answered: requestId };
  }

  async steer(message) {
    if (this.state !== "running") throw new Error(`Session ${this.id} is ${this.state}, cannot steer`);
    await this.session.steer(message);
    return { steered: true, queued: this.session.getSteeringMessages().length };
  }

  async abort() {
    this.state = "aborted";
    this.onChange?.();
    await this.session?.abort().catch(NOOP);
    return { aborted: true };
  }

  dispose() {
    this.unsubscribe?.();
    this.session?.dispose?.();
  }

  snapshot({ verbose = false } = {}) {
    const trace = this.toolCalls.map((c) =>
      verbose ? c : { seq: c.seq, name: c.name, state: c.state, ms: c.ms, args: c.args },
    );
    return {
      sessionId: this.id,
      label: this.label,
      state: this.state,
      model: this.model,
      cwd: this.cwd,
      activeTools: this.activeTools,
      turns: this.turns,
      toolCalls: trace,
      lastText: this.lastText,
      questions: this.pendingQuestions(),
      notices: this.notices,
      error: this.error,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
    };
  }
}
