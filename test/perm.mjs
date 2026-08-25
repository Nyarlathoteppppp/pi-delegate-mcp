import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const mk = async (env) => {
  const c = new Client({ name: "p", version: "0" });
  await c.connect(new StdioClientTransport({ command: "pi-delegate-mcp", env: { ...process.env, ...env } }));
await c.callTool({ name: "init", arguments: {} });
  return c;
};
const probe = async (c, tools) => {
  const r = await c.callTool({ name: "spawn", arguments: { prompt: "Reply only: P", tools, model: "opencode-go/deepseek-v4-flash" } });
  return r.isError ? "REFUSED" : "ALLOWED";
};

console.log("--- default (no env) ---");
let c = await mk({ PI_DELEGATE_ALLOW_TOOLS: "", PI_DELEGATE_ALLOW_WRITE: "" });
console.log("  bash :", await probe(c, ["bash"]));
console.log("  write:", await probe(c, ["write"]));
await c.close();

console.log("--- PI_DELEGATE_ALLOW_TOOLS=bash (project setting) ---");
c = await mk({ PI_DELEGATE_ALLOW_TOOLS: "bash", PI_DELEGATE_ALLOW_WRITE: "" });
console.log("  bash :", await probe(c, ["read","grep","find","ls","bash"]));
console.log("  write:", await probe(c, ["write"]));
console.log("  edit :", await probe(c, ["edit"]));
await c.close();
process.exit(0);
