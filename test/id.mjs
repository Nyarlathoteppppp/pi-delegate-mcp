import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "id", version: "0" });
await c.connect(new StdioClientTransport({ command: "pi-delegate-mcp" }));
await c.callTool({ name: "init", arguments: {} });
const raw=(n,a)=>c.callTool({name:n,arguments:a});
const call=async(n,a)=>JSON.parse((await raw(n,a)).content[0].text);

console.log("[1] custom id + label");
console.log("   ", await call("spawn",{id:"search-audit-01",label:"gỡ ONNX còn sót gì",
  prompt:"Reply only: ONE", model:"opencode-go/deepseek-v4-flash"}));

console.log("\n[2] id trùng bị chặn?");
let r = await raw("spawn",{id:"search-audit-01",prompt:"x"});
console.log("   ", r.isError?"REFUSED:":"ALLOWED:", r.content[0].text.slice(0,90));

console.log("\n[3] id sai định dạng bị chặn?");
r = await raw("spawn",{id:"bad id!",prompt:"x"});
console.log("   ", r.isError?"REFUSED:":"ALLOWED:", r.content[0].text.slice(0,90));

console.log("\n[4] run với id riêng, giữ lại để tra soát");
await call("run",{id:"quick-check",label:"smoke",prompt:"Reply only: TWO",model:"opencode-go/deepseek-v4-flash"});

await new Promise(r=>setTimeout(r,6000));
console.log("\n[5] sessions listing");
console.log(JSON.stringify(await call("sessions",{}),null,1));

console.log("\n[6] forget");
console.log("   ", await call("forget",{sessionId:"quick-check"}));
console.log("    còn lại:", (await call("sessions",{})).count);
await c.close(); process.exit(0);
