import assert from "node:assert/strict";
import { PiWorker } from "../dist/pi/worker.js";
import { assertThinkingSupported } from "../dist/pi/models.js";
import { bindCancellation } from "../dist/tools/spawn.js";
import { waitForProgress } from "../dist/tools/control.js";

function worker(maxTurns, maxDurationMs) {
  return new PiWorker({
    cwd: "/tmp",
    tools: ["read"],
    maxTurns,
    maxDurationMs,
  });
}

// Unsupported thinking must fail before a paid session is started.
assert.throws(
  () => assertThinkingSupported(
    { provider: "test", id: "plain", reasoning: false, thinkingLevelMap: undefined },
    "high",
  ),
  /does not support thinking: high/,
);
assert.doesNotThrow(() => assertThinkingSupported(
  { provider: "test", id: "reasoner", reasoning: true, thinkingLevelMap: { low: "low", high: null } },
  "low",
));
assert.throws(
  () => assertThinkingSupported(
    { provider: "test", id: "reasoner", reasoning: true, thinkingLevelMap: { low: "low", high: null } },
    "high",
  ),
  /does not support thinking: high/,
);

// MCP caller cancellation must reach the worker exactly once.
const controller = new AbortController();
let cancellations = 0;
const unbind = bindCancellation(controller.signal, async () => { cancellations++; });
controller.abort();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(cancellations, 1);
unbind();

// Waiting observes progress but does not own or abort the background worker.
{
  const waiting = {
    state: "running",
    turns: 0,
    toolCalls: [],
    snapshot() { return { state: this.state, turns: this.turns, toolCalls: this.toolCalls }; },
  };
  const pending = waitForProgress(waiting, 500, undefined, 0, 0);
  setTimeout(() => { waiting.turns = 1; }, 20);
  assert.equal((await pending).turns, 1);
  assert.equal(waiting.state, "running");
}

// Tool loops get one finalization steer at 75%, then an abort at the hard turn budget.
{
  const w = worker(4, 60_000);
  let resolvePrompt;
  const promptDone = new Promise((resolve) => { resolvePrompt = resolve; });
  const session = {
    aborts: 0,
    steers: [],
    prompt: async () => promptDone,
    waitForIdle: async () => {},
    steer: async (text) => { session.steers.push(text); },
    abort: async () => { session.aborts++; resolvePrompt(); },
  };
  w.session = session;
  w.track(session, "inspect");
  for (let i = 0; i < 3; i++) {
    w.onEvent({ type: "turn_start" });
    w.onEvent({ type: "turn_end", toolResults: [{}] });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.steers.length, 1);
  w.onEvent({ type: "turn_start" });
  w.onEvent({ type: "turn_end", toolResults: [{}] });
  await w.run;
  assert.equal(session.aborts, 1);
  assert.equal(w.state, "aborted");
  assert.equal(w.termination.reason, "max_turns");
  assert.equal(w.termination.limit, 4);
}

// Wall-clock expiry aborts the underlying session and records a diagnostic reason.
{
  const w = worker(50, 20);
  let resolvePrompt;
  const promptDone = new Promise((resolve) => { resolvePrompt = resolve; });
  const session = {
    prompt: async () => promptDone,
    waitForIdle: async () => {},
    steer: async () => {},
    abort: async () => { resolvePrompt(); },
  };
  w.session = session;
  w.track(session, "inspect");
  await w.run;
  assert.equal(w.state, "aborted");
  assert.equal(w.termination.reason, "deadline");
}

console.log("  OK -> thinking validation, cancellation, non-destructive wait, turn/time circuit breakers");
