import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { basename, relative, resolve } from "node:path";
import {
  createGrepToolDefinition,
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
} from "@earendil-works/pi-coding-agent";
import { assertToolPathsAllowed, blockedSecretPath, SECRET_SEARCH_EXCLUDES } from "../secrets.js";

/** Keep Pi's grep schema and output limits, but exclude secrets before ripgrep visits them. */
export function createProtectedGrepTool(cwd: string): ReturnType<typeof createGrepToolDefinition> {
  const native = createGrepToolDefinition(cwd);
  return {
    ...native,
    async execute(_id, input, signal, _onUpdate, ctx) {
      const workingDir = ctx?.cwd ?? cwd;
      const searchPath = resolve(workingDir, input.path || ".");
      assertToolPathsAllowed("grep", { path: searchPath }, workingDir);
      signal?.throwIfAborted();
      const args = ["--json", "--line-number", "--color=never", "--hidden"];
      if (input.ignoreCase) args.push("--ignore-case");
      if (input.literal) args.push("--fixed-strings");
      if (input.context && input.context > 0) args.push("--context", String(input.context));
      if (input.glob) args.push("--glob", input.glob);
      // Put exclusions after the caller's glob: a broad inclusion must not override them.
      for (const glob of SECRET_SEARCH_EXCLUDES) args.push("--glob", `!${glob}`);
      args.push("--", input.pattern, searchPath);
      const limit = Math.max(1, input.limit ?? 100);

      return new Promise((done, reject) => {
        const child = spawn("rg", args, { cwd: workingDir, stdio: ["ignore", "pipe", "pipe"] });
        const lines = createInterface({ input: child.stdout });
        let stderr = "";
        let matches = 0;
        let reachedLimit = false;
        let linesTruncated = false;
        const output: string[] = [];
        const abort = (): void => { child.kill(); };
        const cleanup = (): void => {
          lines.close();
          signal?.removeEventListener("abort", abort);
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        lines.on("line", (line) => {
          if (reachedLimit || signal?.aborted) return;
          const event = JSON.parse(line) as {
            type: string;
            data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number };
          };
          if (event.type !== "match" && event.type !== "context") return;
          const path = event.data?.path?.text;
          const text = event.data?.lines?.text;
          const lineNumber = event.data?.line_number;
          if (!path || text === undefined || lineNumber === undefined) return;
          // Also check resolved paths so symlink aliases cannot bypass the exclusions.
          if (blockedSecretPath(path, workingDir)) return;
          const display = relative(searchPath, path) || basename(path);
          const separator = event.type === "match" ? ":" : "-";
          const contentLines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
          contentLines.forEach((content, offset) => {
            const truncated = truncateLine(content);
            linesTruncated ||= truncated.wasTruncated;
            output.push(`${display}${separator}${lineNumber + offset}${separator} ${truncated.text}`);
          });
          if (event.type === "match" && ++matches >= limit) {
            reachedLimit = true;
            child.kill();
          }
        });
        child.on("error", (error) => { cleanup(); reject(error); });
        child.on("close", (code) => {
          cleanup();
          if (signal?.aborted) { reject(signal.reason); return; }
          if (!reachedLimit && code !== 0 && code !== 1) {
            reject(new Error(`ripgrep failed: ${stderr.trim() || `exit ${code}`}`));
            return;
          }
          const truncation = truncateHead(output.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
          let text = truncation.content || "No matches found";
          const details: NonNullable<Awaited<ReturnType<typeof native.execute>>["details"]> = {};
          if (reachedLimit) {
            details.matchLimitReached = limit;
            text += `\n\n[${limit} matches limit reached]`;
          }
          if (truncation.truncated) {
            details.truncation = truncation;
            text += `\n\n[Output truncated to ${formatSize(DEFAULT_MAX_BYTES)}]`;
          }
          if (linesTruncated) details.linesTruncated = true;
          done({ content: [{ type: "text", text }], details });
        });
      });
    },
  };
}
