import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const probe = async (label, env) => {
  const c = new Client({name:"n",version:"0"});
  await c.connect(new StdioClientTransport({command:"pi-delegate-mcp", env:{...process.env, ...env}}));
  const i = await c.callTool({name:"init",arguments:{}});
  console.log(`[${label}] init:`, i.isError?"ERROR":"OK");
  console.log("   ", i.content[0].text.replace(/\s+/g," ").slice(0,190));
  const s = await c.callTool({name:"spawn",arguments:{prompt:"x"}});
  console.log("    spawn sau đó:", s.isError?"REFUSED (vẫn khoá)":"ALLOWED (!!)");
  await c.close();
};
await probe("thư mục không tồn tại", {PI_CODING_AGENT_DIR:"/tmp/definitely-not-here"});
console.log();
await probe("thư mục rỗng, chưa login", {PI_CODING_AGENT_DIR:"/tmp/empty-pi-agent"});
process.exit(0);
