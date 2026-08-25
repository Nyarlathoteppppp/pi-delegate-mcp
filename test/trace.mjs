import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name:"tr", version:"0" });
await c.connect(new StdioClientTransport({ command:"pi-delegate-mcp",
  env:{...process.env, PI_DELEGATE_ALLOW_TOOLS:"bash"} }));
const call=async(n,a)=>JSON.parse((await c.callTool({name:n,arguments:a})).content[0].text);
await call("init",{});

await call("run",{ id:"trace-demo", label:"tool trace",
  model:"opencode-go/deepseek-v4-flash", tools:["ls","bash"], cwd:"/tmp",
  prompt:"Run `echo hello-trace` with bash, then ls /usr/share. Then say DONE." });

console.log("=== compact ===");
console.log(JSON.stringify((await call("status",{sessionId:"trace-demo"})).toolCalls, null, 1));
console.log("\n=== verbose ===");
console.log(JSON.stringify((await call("status",{sessionId:"trace-demo",verbose:true})).toolCalls, null, 1).slice(0,1100));
await c.close(); process.exit(0);
