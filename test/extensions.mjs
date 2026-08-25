import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const mk = async (env = {}) => {
  const c = new Client({ name: "x", version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["src/index.mjs"], env: { ...process.env, ...env } }));
  await c.callTool({ name: "init", arguments: {} });
  return c;
};
const raw = (c, n, a = {}) => c.callTool({ name: n, arguments: a });
const call = async (c, n, a = {}) => JSON.parse((await raw(c, n, a)).content[0].text);
const M = "opencode-go/deepseek-v4-flash";

console.log("[1] extensions off: web_search must stay blocked by the allowlist");
let c = await mk();
let r = await raw(c, "spawn", { prompt: "x", model: M, extensions: true, tools: ["read", "web_search"] });
console.log("   ", r.isError ? "REFUSED: " + r.content[0].text.slice(0, 95) : "ALLOWED (!!)");
await c.close();

console.log("\n[2] allowed on the server, extensions ON: does web_search go active?");
c = await mk({ PI_DELEGATE_ALLOW_TOOLS: "web_search,fetch_content" });
let s = await call(c, "spawn", { id: "ext-on", prompt: "Reply only: X", model: M,
  extensions: true, tools: ["read", "grep", "find", "ls", "web_search", "fetch_content"] });
console.log("    activeTools:", JSON.stringify(s.activeTools));

console.log("\n[3] same allowlist, extensions OFF: the extension tools must vanish");
s = await call(c, "spawn", { id: "ext-off", prompt: "Reply only: X", model: M,
  extensions: false, tools: ["read", "grep", "find", "ls", "web_search", "fetch_content"] });
console.log("    activeTools:", JSON.stringify(s.activeTools));
await c.close(); process.exit(0);
