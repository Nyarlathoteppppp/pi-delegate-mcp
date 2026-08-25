#!/usr/bin/env node
/**
 * Claude Code status line segment for pi delegates.
 *
 * Claude Code allows exactly one statusLine command, so this wraps whatever you already
 * run and appends the pi segment:
 *
 *   { "statusLine": { "type": "command",
 *                     "command": "PI_DELEGATE_STATUSLINE_WRAP=ccstatusline pi-delegate-statusline" } }
 *
 * The wrapped command receives the same stdin JSON it would have received alone.
 */
import { spawn } from "node:child_process";
import { ancestors, readAll } from "../src/state.mjs";

// No spinner: a status line is re-rendered on the host's schedule, not on ours, so an
// animation frame picked from the clock reads as jitter. Elapsed time carries real
// information at any refresh rate.
const RUNNING = "▸";
const ESC = "\u001b[";
const DIM = `${ESC}2m`;
const RESET = `${ESC}0m`;
const YELLOW = `${ESC}33m`;
const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;

const readStdin = () =>
  new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => resolve(buf));
  });

const short = (text) => (text.length <= 14 ? text : `${text.slice(0, 13)}…`);

function elapsed(startedAt) {
  if (!startedAt) return "";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
}

function segment(cwd) {
  const servers = readAll();

  // Attribute delegates to *this* session, not merely this repository. The host that
  // launched our server also launched us, so its pid appears in our own ancestry. Two
  // Claude Code sessions on the same repo therefore never show each other's delegates.
  const lineage = new Set(ancestors());
  const ours = servers.filter((s) => lineage.has(s.hostPid));

  // Older state files carry no hostPid; fall back to matching on the workspace.
  const chosen = ours.length ? ours : servers.filter((s) => s.hostPid === undefined);
  const all = chosen.flatMap((s) => s.sessions ?? []);
  const mine = ours.length ? all : cwd ? all.filter((s) => s.cwd === cwd) : all;
  if (mine.length === 0) return "";

  const running = mine.filter((s) => s.state === "running" || s.state === "starting");
  const asking = mine.filter((s) => s.questions > 0);
  const failed = mine.filter((s) => s.state === "error");

  if (running.length === 0 && asking.length === 0) {
    const done = mine.filter((s) => s.state === "done").length;
    const parts = [];
    if (done) parts.push(`${GREEN}✓${done}${RESET}`);
    if (failed.length) parts.push(`${RED}✗${failed.length}${RESET}`);
    return parts.length ? `${DIM}π${RESET} ${parts.join(" ")}` : "";
  }

  const detail = running
    .slice(0, 3)
    .map((s) => {
      const age = elapsed(s.startedAt);
      return `${short(s.label || s.id)}${DIM}·t${s.turns}${age ? `·${age}` : ""}${RESET}`;
    })
    .join(" ");
  const more = running.length > 3 ? ` ${DIM}+${running.length - 3}${RESET}` : "";
  const ask = asking.length ? ` ${YELLOW}?${asking.length} waiting${RESET}` : "";
  return `${DIM}π${RESET} ${RUNNING} ${detail}${more}${ask}`.trim();
}

const raw = await readStdin();

if (process.env.PI_DELEGATE_STATUSLINE_LOG) {
  try {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.PI_DELEGATE_STATUSLINE_LOG, `${Date.now()}\n`);
  } catch {}
}

let cwd;
try {
  cwd = JSON.parse(raw)?.workspace?.current_dir;
} catch {
  // A malformed payload just means we cannot scope to a workspace.
}

const pi = segment(cwd);
const wrap = process.env.PI_DELEGATE_STATUSLINE_WRAP;

if (!wrap) {
  if (pi) process.stdout.write(`${pi}\n`);
  process.exit(0);
}

const child = spawn(wrap, { shell: true, stdio: ["pipe", "pipe", "inherit"] });
let out = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (d) => (out += d));
child.on("error", () => {
  process.stdout.write(pi ? `${pi}\n` : "\n");
});
child.on("close", () => {
  const base = out.replace(/\n+$/, "");
  const lines = base ? base.split("\n") : [];
  if (pi) lines.push(pi);
  process.stdout.write(`${lines.join("\n")}\n`);
});
child.stdin.end(raw);
