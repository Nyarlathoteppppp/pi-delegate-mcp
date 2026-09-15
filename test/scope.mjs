import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const mk = async (env={}) => {
  const c = new Client({name:"s",version:"0"});
  await c.connect(new StdioClientTransport({command:"pi-delegate-mcp",
    env:{...process.env, PI_DELEGATE_ALLOW_TOOLS:"bash", ...env}}));
  return c;
};
const raw=(c,n,a={})=>c.callTool({name:n,arguments:a});
const call=async(c,n,a={})=>JSON.parse((await raw(c,n,a)).content[0].text);

let c = await mk();
const info = await call(c,"init");
console.log("[pi health]", JSON.stringify(info.pi));
console.log("[scoped]   ", info.models.scoped);
console.log("[available]", JSON.stringify(info.models.available));

console.log("\n[in-scope model]");
let r = await raw(c,"spawn",{id:"s1",prompt:"Reply only: IN",model:"opencode-go/deepseek-v4-flash",cwd:"/tmp"});
console.log("   ", r.isError?"REFUSED":"ALLOWED");

console.log("\n[custom provider - phải vẫn OK]");
r = await raw(c,"spawn",{id:"s2",prompt:"x",model:"knowns-hub/claude-fast",cwd:"/tmp"});
console.log("   ", r.isError?"REFUSED: "+r.content[0].text.slice(0,90):"ALLOWED");

console.log("\n[ngoài scope - phải bị chặn]");
for (const m of ["opencode-go/glm-5.3","openrouter/deepseek/deepseek-v3.2"]) {
  r = await raw(c,"spawn",{prompt:"x",model:m,cwd:"/tmp"});
  console.log(`    ${m}:`, r.isError?"REFUSED":"ALLOWED");
}
console.log("    lý do:", (await raw(c,"spawn",{prompt:"x",model:"opencode-go/glm-5.3",cwd:"/tmp"})).content[0].text.slice(0,160));
await c.close();

console.log("\n[PI_DELEGATE_IGNORE_SCOPE=1 - mở khoá]");
c = await mk({PI_DELEGATE_IGNORE_SCOPE:"1"});
await call(c,"init");
r = await raw(c,"spawn",{prompt:"Reply only: X",model:"opencode-go/glm-5.3",cwd:"/tmp"});
console.log("    opencode-go/glm-5.3:", r.isError?"REFUSED":"ALLOWED");
await c.close(); process.exit(0);
