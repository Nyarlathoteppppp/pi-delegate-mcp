import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "f", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));
const raw = (n, a = {}) => c.callTool({ name: n, arguments: a });
const call = async (n, a = {}) => JSON.parse((await raw(n, a)).content[0].text);
const M = "opencode-go/deepseek-v4-flash";
const settle = async (id) => {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await call("status", { sessionId: id });
    if (s.state !== "running" && s.state !== "starting") return s;
  }
  throw new Error("never settled");
};
await call("init");

console.log("[1] turn one");
await call("spawn", { id: "quiz", label: "multi-turn", model: M, cwd: "/tmp",
  prompt: "Remember the number 4271. Reply only: STORED" });
let s = await settle("quiz");
console.log(`    state=${s.state} turns=${s.turns} lastText=${JSON.stringify(s.lastText)}`);

console.log("\n[2] follow_up on the finished session: does it still remember?");
console.log("   ", await call("follow_up", { sessionId: "quiz",
  prompt: "What number did I ask you to remember? Reply with just the number." }));
s = await settle("quiz");
console.log(`    state=${s.state} turns=${s.turns} lastText=${JSON.stringify(s.lastText)}`);
console.log("   ", s.lastText.includes("4271") ? "CONTEXT SURVIVED" : "CONTEXT LOST (!!)");

console.log("\n[3] follow_up on a running session must be refused (steer is for that)");
await call("spawn", { id: "busy", model: M, cwd: "/tmp", prompt: "Count slowly from 1 to 40, one line each." });
let r = await raw("follow_up", { sessionId: "busy", prompt: "x" });
console.log("   ", r.isError ? "REFUSED: " + r.content[0].text.slice(0, 95) : "ALLOWED (!!)");
await call("abort", { sessionId: "busy" });

console.log("\n[4] follow_up on an unknown session");
r = await raw("follow_up", { sessionId: "nope", prompt: "x" });
console.log("   ", r.isError ? "REFUSED: " + r.content[0].text.slice(0, 60) : "ALLOWED (!!)");
await c.close(); process.exit(0);
