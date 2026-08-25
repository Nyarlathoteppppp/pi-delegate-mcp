import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "guard", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));
await c.callTool({ name: "init", arguments: {} });
const raw = (n, a) => c.callTool({ name: n, arguments: a });

console.log("[1] bash blocked?");
let r = await raw("spawn", { prompt: "x", tools: ["bash"] });
console.log("   ", r.isError ? "REFUSED:" : "ALLOWED:", r.content[0].text.slice(0, 130));

console.log("\n[2] bogus model rejected?");
r = await raw("spawn", { prompt: "x", model: "nope/does-not-exist" });
console.log("   ", r.isError ? "REFUSED:" : "ALLOWED:", r.content[0].text.slice(0, 130));

console.log("\n[3] run (blocking) works?");
r = await raw("run", { prompt: "Reply with exactly: RUN_OK", model: "opencode-go/deepseek-v4-flash" });
const s = JSON.parse(r.content[0].text);
console.log("    state=%s model=%s tools=%j lastText=%j", s.state, s.model, s.activeTools, s.lastText);

console.log("\n[4] unknown session rejected?");
r = await raw("status", { sessionId: "nope" });
console.log("   ", r.isError ? "REFUSED:" : "ALLOWED:", r.content[0].text.slice(0, 100));
await c.close(); process.exit(0);
