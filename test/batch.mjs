import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "batch", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));
const raw = (n, a = {}) => c.callTool({ name: n, arguments: a });
const call = async (n, a = {}) => JSON.parse((await raw(n, a)).content[0].text);
await call("init");

console.log("[1] bad model in tasks[2] must kill the whole batch, launching nothing");
let r = await raw("spawn_batch", { idPrefix: "pre", model: "opencode-go/deepseek-v4-flash", cwd: "/tmp", tasks: [
  { prompt: "Reply only: A" }, { prompt: "Reply only: B" }, { prompt: "x", model: "nope/nope" }] });
console.log("   ", r.isError ? "REFUSED: " + r.content[0].text.slice(0, 110) : "ALLOWED (!!)");
console.log("    sessions after:", (await call("sessions")).count);

console.log("\n[2] duplicate id inside one batch");
r = await raw("spawn_batch", { cwd: "/tmp", tasks: [{ prompt: "a", id: "dup" }, { prompt: "b", id: "dup" }] });
console.log("   ", r.isError ? "REFUSED: " + r.content[0].text.slice(0, 100) : "ALLOWED (!!)");

console.log("\n[3] blocked tool in one task");
r = await raw("spawn_batch", { cwd: "/tmp", tasks: [{ prompt: "a" }, { prompt: "b", tools: ["bash"] }] });
console.log("   ", r.isError ? "REFUSED: " + r.content[0].text.slice(0, 100) : "ALLOWED (!!)");

console.log("\n[4] happy path: 5 delegates, one call");
const t0 = Date.now();
console.log(JSON.stringify(await call("spawn_batch", {
  idPrefix: "audit", model: "opencode-go/deepseek-v4-flash", cwd: "/tmp", tools: ["ls"],
  tasks: [
    { prompt: "Reply only: ONE", label: "one" },
    { prompt: "Reply only: TWO", label: "two" },
    { prompt: "Reply only: THREE", label: "three" },
    { prompt: "Reply only: FOUR", label: "four", model: "opencode-go/ox-alpha-free" },
    { prompt: "Reply only: FIVE", label: "five" },
  ],
}), null, 1));
console.log(`    launched in ${Date.now() - t0}ms`);

console.log("\n[5] one `sessions` call covers all five");
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const s = await call("sessions");
  if (!s.sessions.some((x) => x.state === "running" || x.state === "starting")) {
    console.log(JSON.stringify(s.sessions.map(({ sessionId, label, state, model, turns }) => ({ sessionId, label, state, model, turns })), null, 1));
    break;
  }
}
console.log("\n[6] over the cap");
r = await raw("spawn_batch", { cwd: "/tmp", tasks: Array.from({ length: 11 }, (_, i) => ({ prompt: `t${i}` })) });
console.log("   ", r.isError ? "REFUSED: " + r.content[0].text.slice(0, 120) : "ALLOWED (!!)");
await c.close(); process.exit(0);
