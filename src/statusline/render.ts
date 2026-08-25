import type { PublishedSession, StateFile } from "../types.js";
import { ancestors, readAll } from "./state.js";

// No spinner: a status line is re-rendered on the host's schedule, not on ours, so an
// animation frame picked from the clock reads as jitter. Elapsed time carries real
// information at any refresh rate.
const RUNNING = "▸";

// ESC built from its char code so this source file holds no raw control bytes.
const ESC = `${String.fromCharCode(27)}[`;
const DIM = `${ESC}2m`;
const RESET = `${ESC}0m`;
const YELLOW = `${ESC}33m`;
const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;

const short = (text: string): string => (text.length <= 14 ? text : `${text.slice(0, 13)}…`);

export function elapsed(startedAt: string | undefined): string {
  if (!startedAt) return "";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
}

/** Pick the delegates belonging to the session this status line is rendering for. */
function mine(servers: StateFile[], cwd: string | undefined): PublishedSession[] {
  // Attribute delegates to *this* session, not merely this repository. The host that
  // launched our server also launched us, so its pid appears in our own ancestry. Two
  // Claude Code sessions on the same repo therefore never show each other's delegates.
  const lineage = new Set(ancestors());
  const ours = servers.filter((s) => s.hostPid !== undefined && lineage.has(s.hostPid));

  // Older state files carry no hostPid; fall back to matching on the workspace.
  const chosen = ours.length ? ours : servers.filter((s) => s.hostPid === undefined);
  const sessions = chosen.flatMap((s) => s.sessions ?? []);
  if (ours.length) return sessions;
  return cwd ? sessions.filter((s) => s.cwd === cwd) : sessions;
}

export function segment(cwd?: string): string {
  const sessions = mine(readAll(), cwd);
  if (sessions.length === 0) return "";

  const running = sessions.filter((s) => s.state === "running" || s.state === "starting");
  const asking = sessions.filter((s) => s.questions > 0);
  const failed = sessions.filter((s) => s.state === "error");

  if (running.length === 0 && asking.length === 0) {
    const done = sessions.filter((s) => s.state === "done").length;
    const parts: string[] = [];
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
