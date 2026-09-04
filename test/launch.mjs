import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [cmd, ...args] = process.argv.slice(2);
const c = new Client({ name: "launch", version: "0" });
await c.connect(new StdioClientTransport({ command: cmd, args }));
const { tools } = await c.listTools();
const spawn = tools.find((tool) => tool.name === "spawn");
if (!spawn?.inputSchema?.properties?.thinking)
  throw new Error("spawn schema does not expose the thinking argument");
if (!spawn?.inputSchema?.properties?.maxTurns || !spawn?.inputSchema?.properties?.maxDurationMs)
  throw new Error("spawn schema does not expose worker safety budgets");
if (!tools.some((tool) => tool.name === "wait"))
  throw new Error("server does not expose non-destructive wait");
console.log(`  OK -> ${tools.length} tools: ${tools.map(t=>t.name).join(", ")}`);
await c.close(); process.exit(0);
