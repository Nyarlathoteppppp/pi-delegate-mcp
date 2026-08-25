import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ancestors, readAll, STATE_DIR } from "../dist/statusline/state.js";

const CWD = "/tmp";
const ANSI = new RegExp("\\u001b\\[\\d+m", "g");
const payload = JSON.stringify({ workspace: { current_dir: CWD } });
const line = () =>
  execFileSync("pi-delegate-statusline", { input: payload, encoding: "utf8" }).replace(ANSI, "").trim();

// A server launched by *this* process: its hostPid is our pid, which is in our ancestry.
const c = new Client({ name: "attr", version: "0" });
await c.connect(new StdioClientTransport({ command: "pi-delegate-mcp" }));
const call = async (n, a = {}) => JSON.parse((await c.callTool({ name: n, arguments: a })).content[0].text);
await call("init");
await call("spawn", {
  id: "mine", label: "mine", cwd: CWD, tools: ["ls"],
  model: "opencode-go/deepseek-v4-flash",
  prompt: "List /usr/share, then /usr/lib, then /etc. One ls per step, narrate each.",
});
await new Promise((r) => setTimeout(r, 3000));

// A state file from a different session. It must survive the liveness prune to be a real
// test, so name it after pid 1 — always alive — and give it a hostPid we are not under.
const FOREIGN = join(STATE_DIR, "1.json");
mkdirSync(STATE_DIR, { recursive: true });
writeFileSync(
  FOREIGN,
  JSON.stringify({
    pid: 1,
    hostPid: 999999, // not one of our ancestors
    sessions: [{ id: "theirs", label: "OTHER SESSION", state: "running", cwd: CWD, turns: 9, questions: 0 }],
  }),
);

console.log("ancestry      :", ancestors().join(" <- "));
console.log("state files   :", readAll().map((s) => `pid=${s.pid} host=${s.hostPid}`).join("  "));
const out = line();
console.log("statusline    :", JSON.stringify(out));
console.log("thấy 'mine'   :", out.includes("mine") ? "YES (đúng)" : "NO (SAI)");
console.log("thấy 'OTHER'  :", out.includes("OTHER") ? "YES (SAI - lẫn session)" : "NO (đúng)");

rmSync(FOREIGN, { force: true });
await c.close();
process.exit(out.includes("mine") && !out.includes("OTHER") ? 0 : 1);
