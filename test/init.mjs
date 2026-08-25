import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name:"i", version:"0" });
const t = new StdioClientTransport({ command:"pi-delegate-mcp",
  env:{...process.env, PI_DELEGATE_ALLOW_TOOLS:"bash", PI_DELEGATE_MODEL:"openrouter/stealth/ox-alpha"} });
await c.connect(t);

console.log("[server instructions]");
console.log("  ", (c.getInstructions?.() ?? "(none)").slice(0,150), "\n");

const raw=(n,a={})=>c.callTool({name:n,arguments:a});
console.log("[1] gọi spawn TRƯỚC init:");
let r = await raw("spawn",{prompt:"x"});
console.log("   ", r.isError?"REFUSED:":"ALLOWED:", r.content[0].text.slice(0,110));

console.log("\n[2] gọi models TRƯỚC init:");
r = await raw("models",{});
console.log("   ", r.isError?"REFUSED:":"ALLOWED:", r.content[0].text.slice(0,80));

console.log("\n[3] init:");
const info = JSON.parse((await raw("init",{})).content[0].text);
console.log(JSON.stringify(info, null, 1).slice(0, 1800));

console.log("\n[4] spawn SAU init:");
r = await raw("spawn",{id:"after-init",prompt:"Reply only: GO",model:"opencode-go/deepseek-v4-flash"});
console.log("   ", r.isError?"REFUSED:":"ALLOWED:", r.content[0].text.slice(0,120));
await c.close(); process.exit(0);
