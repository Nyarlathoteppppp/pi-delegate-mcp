import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [cmd, ...args] = process.argv.slice(2);
const c = new Client({ name: "launch", version: "0" });
await c.connect(new StdioClientTransport({ command: cmd, args }));
const { tools } = await c.listTools();
console.log(`  OK -> ${tools.length} tools: ${tools.map(t=>t.name).join(", ")}`);
await c.close(); process.exit(0);
