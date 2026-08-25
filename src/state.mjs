import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The status line runs as a separate process, so live session state has to reach it
 * through the filesystem. One file per server instance, named by pid; readers treat a
 * file whose pid is gone as stale.
 */
export const STATE_DIR =
  process.env.PI_DELEGATE_STATE_DIR ||
  join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi-delegate-mcp");

const FILE = join(STATE_DIR, `${process.pid}.json`);
const WRITE_THROTTLE_MS = 250;

let pending;
let timer;

function flush() {
  timer = undefined;
  const payload = pending;
  pending = undefined;
  if (!payload) return;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    // Write-then-rename so a reader never sees a half-written file.
    const temp = join(tmpdir(), `pi-delegate-${process.pid}-${Date.now()}.json`);
    writeFileSync(temp, JSON.stringify(payload));
    rmSync(FILE, { force: true });
    writeFileSync(FILE, readFileSync(temp));
    rmSync(temp, { force: true });
  } catch {
    // The status line is a convenience. Never let it break a delegate.
  }
}

export function publish(sessions) {
  pending = {
    pid: process.pid,
    // The host that launched this server. A status line spawned by the same host finds
    // this pid in its own ancestry, which is how delegates get attributed to the right
    // session even when two sessions share a repository.
    hostPid: process.ppid,
    updatedAt: new Date().toISOString(),
    sessions: [...sessions].map((w) => ({
      id: w.id,
      label: w.label,
      state: w.state,
      model: w.model,
      cwd: w.cwd,
      turns: w.turns,
      questions: w.questions?.size ?? 0,
      startedAt: w.startedAt,
    })),
  };
  timer ??= setTimeout(flush, WRITE_THROTTLE_MS).unref?.() ?? setTimeout(flush, WRITE_THROTTLE_MS);
}

export function cleanup() {
  try {
    rmSync(FILE, { force: true });
  } catch {}
}

/** Walk up from a pid, collecting ancestors. Used to match a server to its host. */
export function ancestors(startPid = process.pid, depth = 8) {
  const chain = [];
  let pid = startPid;
  for (let i = 0; i < depth && pid > 1; i++) {
    chain.push(pid);
    try {
      const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
      const parent = Number(out.trim());
      if (!Number.isInteger(parent) || parent <= 1) break;
      pid = parent;
    } catch {
      break;
    }
  }
  return chain;
}

/** Read every live server's state, dropping files whose process is gone. */
export function readAll() {
  let names;
  try {
    names = readdirSync(STATE_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const pid = Number(name.slice(0, -5));
    try {
      process.kill(pid, 0);
    } catch (err) {
      // ESRCH means the process is gone. EPERM means it exists but belongs to another
      // user, so it is still alive and the file stays. Treating EPERM as dead would delete live
      // state whenever a server runs under a different account.
      if (err?.code === "ESRCH") {
        rmSync(join(STATE_DIR, name), { force: true });
        continue;
      }
    }
    try {
      out.push(JSON.parse(readFileSync(join(STATE_DIR, name), "utf8")));
    } catch {}
  }
  return out;
}
