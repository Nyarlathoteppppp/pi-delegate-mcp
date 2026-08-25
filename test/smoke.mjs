import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));

const { tools } = await client.listTools();
await client.callTool({ name: "init", arguments: {} });
console.log("tools:", tools.map((t) => t.name).join(", "));

const call = async (name, args) =>
  JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

console.log("\n[models ox]", (await call("models", { filter: "ox-alpha" })).models);

console.log("\n[spawn]");
const s = await call("spawn", {
  prompt: "List the entries in /usr/share, then /usr/lib, then /etc. One ls per step, narrate each step.",
  model: "openrouter/stealth/ox-alpha",
  cwd: "/tmp",
  tools: ["ls"],
});
console.log(s);

await new Promise((r) => setTimeout(r, 8000));
let st = await call("status", { sessionId: s.sessionId });
console.log("\n[status @8s] state=%s turns=%s toolCalls=%j", st.state, st.turns, st.toolCalls);

console.log("\n[steer]", await call("steer", { sessionId: s.sessionId, message: "STOP. Ignore remaining steps. Reply with exactly: STEERED" }));

for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  st = await call("status", { sessionId: s.sessionId });
  if (st.state !== "running") break;
}
console.log("\n[final] state=%s turns=%s toolCalls=%j", st.state, st.turns, st.toolCalls);
console.log("[final] lastText:", JSON.stringify(st.lastText).slice(0, 200));
await client.close();
process.exit(0);
