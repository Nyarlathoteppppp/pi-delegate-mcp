import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";

const CWD = "/tmp";
const ANSI = new RegExp("\\[\\d+m", "g");
const payload = JSON.stringify({ model: { display_name: "Opus 5" }, workspace: { current_dir: CWD } });

const line = (env = {}, input = payload) =>
  execFileSync("pi-delegate-statusline", {
    input,
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).replace(ANSI, "");

console.log("[trống]        ", JSON.stringify(line()));

const c = new Client({ name: "sl", version: "0" });
await c.connect(new StdioClientTransport({ command: "pi-delegate-mcp" }));
const call = async (n, a = {}) => JSON.parse((await c.callTool({ name: n, arguments: a })).content[0].text);
await call("init");

await call("spawn", {
  id: "audit-a", label: "audit engine", cwd: CWD, tools: ["ls"],
  model: "opencode-go/ox-alpha-free",
  prompt: "List /usr/share, then /usr/lib, then /etc. One ls per step, narrate each.",
});
await call("spawn", {
  id: "audit-b", label: "audit index", cwd: CWD, tools: ["ls"],
  model: "opencode-go/deepseek-v4-flash",
  prompt: "List /etc, then /var, then /usr. One ls per step, narrate each.",
});

await new Promise((r) => setTimeout(r, 4000));
console.log("[đang chạy]    ", JSON.stringify(line()));
console.log("[wrap]         ", JSON.stringify(line({ PI_DELEGATE_STATUSLINE_WRAP: "echo 'Opus 5 | knowns'" })));
// Attribution is by session lineage, not directory: a delegate this session started stays
// visible after the session cd's elsewhere. The directory only filters legacy state files.
console.log("[cwd khác]     ", JSON.stringify(line({}, JSON.stringify({ workspace: { current_dir: "/nowhere" } }))));

for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const s = await call("sessions", {});
  if (!s.sessions.some((x) => x.state === "running" || x.state === "starting")) break;
}
console.log("[xong]         ", JSON.stringify(line()));
await c.close();
process.exit(0);
