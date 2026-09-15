import { randomUUID } from "node:crypto";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSessionEvent,
  type ExtensionUIContext,
  type CreateAgentSessionResult,
} from "@earendil-works/pi-coding-agent";
import { AGENT_DIR } from "../config.js";
import { secretPathGuard } from "../secrets.js";
import type {
  Notice,
  PiThinkingLevel,
  SessionState,
  Snapshot,
  Termination,
  TerminationReason,
  ToolCall,
  ToolCallSummary,
} from "../types.js";
import { assertThinkingSupported, resolveModel } from "./models.js";
import { getRuntime } from "./runtime.js";
import { clipArgs, flatten } from "./trace.js";
import { createUiContext, Question } from "./ui.js";

type AgentSession = CreateAgentSessionResult["session"];

const NOOP = (): void => {};

export interface WorkerOptions {
  id?: string | undefined;
  label?: string | undefined;
  cwd: string;
  model?: string | undefined;
  thinking?: PiThinkingLevel | undefined;
  tools: string[];
  extensions?: boolean;
  maxTurns: number;
  maxDurationMs: number;
}

const FINALIZE_PROMPT =
  "Stop expanding the investigation and do not call more tools. Return the best conclusion now from " +
  "the evidence already collected. Include concrete evidence, uncertainty, blockers, and the next action.";

/**
 * One delegated pi session. Holds the live AgentSession in-process, which is what keeps
 * steering and questions available; a subprocess running `pi -p` can do neither.
 */
export class PiWorker {
  readonly id: string;
  readonly label: string | undefined;
  readonly cwd: string;
  readonly toolNames: string[];
  readonly startedAt: string;
  readonly maxTurns: number;
  readonly maxDurationMs: number;

  state: SessionState = "starting";
  turns = 0;
  lastText = "";
  model: string | undefined;
  activeTools: string[] | undefined;
  error: string | undefined;
  finishedAt: string | undefined;
  thinking: PiThinkingLevel | undefined;
  termination: Termination | undefined;

  readonly toolCalls: ToolCall[] = [];
  readonly notices: Notice[] = [];
  readonly questions = new Map<string, Question>();

  /** Resolves when the delegate stops, however it stops. Never rejects. */
  run: Promise<void> | undefined;
  /** Set by the registry so state reaches the status line on every transition. */
  onChange: (() => void) | undefined;

  private readonly extensionsEnabled: boolean;
  private readonly modelSpec: string | undefined;
  private readonly thinkingSpec: PiThinkingLevel | undefined;
  private readonly openCalls = new Map<string, ToolCall>();
  private session: AgentSession | undefined;
  private unsubscribe: (() => void) | undefined;
  private deadlineTimer: NodeJS.Timeout | undefined;
  private runTurns = 0;
  private finishSteerSent = false;

  constructor({
    id,
    label,
    cwd,
    model,
    thinking,
    tools,
    extensions = false,
    maxTurns,
    maxDurationMs,
  }: WorkerOptions) {
    this.id = id ?? randomUUID();
    this.label = label;
    this.cwd = cwd;
    this.modelSpec = model;
    this.thinkingSpec = thinking;
    this.toolNames = tools;
    this.extensionsEnabled = extensions;
    this.maxTurns = maxTurns;
    this.maxDurationMs = maxDurationMs;
    this.startedAt = new Date().toISOString();
  }

  private uiContext(): ExtensionUIContext {
    return createUiContext({
      ask: (kind, title, detail, options) => {
        const q = new Question(kind, title, detail, options);
        this.questions.set(q.id, q);
        this.onChange?.();
        return q.promise;
      },
      notify: (message, type = "info") => {
        this.notices.push({ type, message, at: new Date().toISOString() });
      },
    });
  }

  async start(prompt: string): Promise<this> {
    const model = await resolveModel(this.modelSpec, this.cwd);

    assertThinkingSupported(model, this.thinkingSpec);

    // Third-party pi extensions start timers and sockets that outlive dispose() and then
    // throw against a stale ctx. A delegate does not need them.
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: AGENT_DIR,
      noExtensions: !this.extensionsEnabled,
      noSkills: true,
      noContextFiles: true,
      extensionFactories: [secretPathGuard(this.cwd)],
    });

    // The loader is lazy: getExtensions() returns nothing until reload() has run.
    // Always reload so the inline secret-path guard is installed even when third-party
    // extensions stay off. A failure is not fatal.
    try {
      await resourceLoader.reload();
    } catch (e) {
      this.notices.push({
        type: "warning",
        message: `resource loader failed: ${message(e)}`,
        at: new Date().toISOString(),
      });
    }

    const { session } = await createAgentSession({
      cwd: this.cwd,
      modelRuntime: await getRuntime(),
      model,
      thinkingLevel: this.thinkingSpec,
      sessionManager: SessionManager.inMemory(),
      tools: this.toolNames,
      resourceLoader,
    });
    this.session = session;
    this.model = model ? `${model.provider}/${model.id}` : "(pi default)";
    this.thinking = session.thinkingLevel;
    this.activeTools = session.getActiveToolNames();

    this.unsubscribe = session.subscribe((ev) => this.onEvent(ev));
    try {
      await session.bindExtensions({ uiContext: this.uiContext(), mode: "rpc" });
    } catch {
      // Extensions are optional. A binding failure must not sink the run.
    }

    this.track(session, prompt);
    return this;
  }

  /**
   * Drive one prompt to completion and fold the outcome back into this worker. Shared by
   * `start` and `followUp` so a second turn behaves exactly like the first.
   */
  private track(session: AgentSession, prompt: string): void {
    this.state = "running";
    this.error = undefined;
    this.finishedAt = undefined;
    this.termination = undefined;
    this.runTurns = 0;
    this.finishSteerSent = false;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    const remainingMs = Math.max(1, this.maxDurationMs - this.elapsedMs());
    this.deadlineTimer = setTimeout(() => {
      void this.abort("deadline", { limit: this.maxDurationMs, observed: this.elapsedMs() });
    }, remainingMs);
    this.run = session
      .prompt(prompt)
      .then(() => session.waitForIdle())
      .then(() => {
        this.state = this.state === "aborted" ? "aborted" : "done";
      })
      .catch((e: unknown) => {
        if (this.state !== "aborted") {
          this.state = "error";
          this.error = message(e);
        }
      })
      .finally(() => {
        if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
        this.deadlineTimer = undefined;
        this.finishedAt = new Date().toISOString();
        // Unblock anything still waiting on an answer that will now never come.
        for (const q of this.questions.values()) q.resolve(undefined);
        this.onChange?.();
      });
  }

  /**
   * Send another prompt to a delegate that has already finished. pi keeps the session's
   * history in memory, so the delegate still remembers everything it read and said. This
   * is the difference between a conversation and re-explaining yourself to a fresh agent.
   */
  followUp(prompt: string): { sessionId: string; state: SessionState; turnsSoFar: number } {
    if (!this.session) throw new Error(`Session ${this.id} never started, nothing to follow up on.`);
    if (this.state === "running" || this.state === "starting")
      throw new Error(
        `Session ${this.id} is ${this.state}. Use \`steer\` to redirect a delegate that is still working.`,
      );
    if (this.turns >= this.maxTurns) {
      throw new Error(
        `Session ${this.id} already used ${this.turns}/${this.maxTurns} turns. Spawn a new delegate instead of follow_up.`,
      );
    }
    if (this.elapsedMs() >= this.maxDurationMs) {
      throw new Error(
        `Session ${this.id} already reached its ${this.maxDurationMs}ms deadline. Spawn a new delegate instead of follow_up.`,
      );
    }
    this.track(this.session, prompt);
    this.onChange?.();
    return { sessionId: this.id, state: this.state, turnsSoFar: this.turns };
  }

  private onEvent(ev: AgentSessionEvent): void {
    switch (ev.type) {
      case "turn_start":
        this.turns++;
        this.runTurns++;
        this.onChange?.();
        break;

      case "turn_end": {
        // A tool-free turn is normally the final answer. Budget only an agent that is
        // continuing the tool loop, so a conclusion at the limit is not thrown away.
        if (this.state !== "running" || ev.toolResults.length === 0) break;
        if (this.turns >= this.maxTurns) {
          void this.abort("max_turns", { limit: this.maxTurns, observed: this.turns });
          break;
        }
        const finishAt = Math.max(1, Math.floor(this.maxTurns * 0.75));
        if (!this.finishSteerSent && this.turns >= finishAt && this.questions.size === 0) {
          this.finishSteerSent = true;
          this.notices.push({
            type: "warning",
            message: `turn budget ${this.turns}/${this.maxTurns}: requested final answer without more tools`,
            at: new Date().toISOString(),
          });
          void this.session?.steer(FINALIZE_PROMPT).catch((e: unknown) => {
            this.notices.push({
              type: "warning",
              message: `automatic finalization steer failed: ${message(e)}`,
              at: new Date().toISOString(),
            });
          });
        }
        break;
      }

      case "tool_execution_start": {
        const call: ToolCall = {
          seq: this.toolCalls.length + 1,
          id: ev.toolCallId,
          name: ev.toolName,
          args: clipArgs(ev.args),
          state: "running",
          startedAt: Date.now(),
        };
        this.toolCalls.push(call);
        if (ev.toolCallId) this.openCalls.set(ev.toolCallId, call);
        break;
      }

      case "tool_execution_end": {
        // pi does not always echo the call id back, so fall back to the newest open call
        // of the same name rather than losing the timing entirely.
        const call =
          (ev.toolCallId ? this.openCalls.get(ev.toolCallId) : undefined) ??
          [...this.toolCalls].reverse().find((c) => c.state === "running" && c.name === ev.toolName);
        if (call) {
          call.state = ev.isError ? "error" : "ok";
          call.ms = Date.now() - (call.startedAt ?? Date.now());
          call.result = flatten(ev.result);
          delete call.startedAt;
          if (ev.toolCallId) this.openCalls.delete(ev.toolCallId);
        }
        break;
      }

      case "message_update":
        if (ev.assistantMessageEvent?.type === "text_end")
          this.lastText = ev.assistantMessageEvent.content ?? this.lastText;
        break;
    }
  }

  pendingQuestions() {
    return [...this.questions.values()].map((q) => q.toJSON());
  }

  answer(requestId: string, value: string | boolean): { answered: string } {
    const q = this.questions.get(requestId);
    if (!q) throw new Error(`No pending question ${requestId} on session ${this.id}`);
    this.questions.delete(requestId);
    q.resolve(q.kind === "confirm" ? value === true || value === "true" : value);
    this.onChange?.();
    return { answered: requestId };
  }

  async steer(text: string): Promise<{ steered: true; queued: number }> {
    if (this.state !== "running" || !this.session)
      throw new Error(`Session ${this.id} is ${this.state}, cannot steer`);
    await this.session.steer(text);
    return { steered: true, queued: this.session.getSteeringMessages().length };
  }

  async abort(
    reason: TerminationReason = "manual_abort",
    detail: { limit?: number; observed?: number } = {},
  ): Promise<{ aborted: true; termination: Termination }> {
    if (!this.termination)
      this.termination = {
        reason,
        ...(detail.limit === undefined ? {} : { limit: detail.limit }),
        ...(detail.observed === undefined ? {} : { observed: detail.observed }),
        at: new Date().toISOString(),
      };
    this.state = "aborted";
    this.onChange?.();
    await this.session?.abort().catch(NOOP);
    return { aborted: true, termination: this.termination };
  }

  dispose(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.unsubscribe?.();
    this.session?.dispose?.();
  }

  private elapsedMs(): number {
    return Date.now() - Date.parse(this.startedAt);
  }

  snapshot({ verbose = false }: { verbose?: boolean } = {}): Snapshot {
    const trace: Array<ToolCall | ToolCallSummary> = this.toolCalls.map((c) =>
      verbose ? c : { seq: c.seq, name: c.name, state: c.state, ms: c.ms, args: c.args },
    );
    return {
      sessionId: this.id,
      label: this.label,
      state: this.state,
      model: this.model,
      thinking: this.thinking,
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
      elapsedMs: this.elapsedMs(),
      limits: { maxTurns: this.maxTurns, maxDurationMs: this.maxDurationMs },
      termination: this.termination,
    };
  }
}

/** Errors reach us as `unknown`; this is the one place that decides how to read them. */
export function message(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
