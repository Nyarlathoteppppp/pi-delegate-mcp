import { TRACE_ARGS, TRACE_RESULT } from "../config.js";

/** Tool results can be an entire file. Keep a readable head, record what was dropped. */
export function clip(value: unknown, limit: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return undefined;
  return text.length <= limit ? text : `${text.slice(0, limit)}… [+${text.length - limit} chars]`;
}

export const clipArgs = (value: unknown): string | undefined => clip(value, TRACE_ARGS);

interface ContentPart {
  type?: string;
  text?: string;
}

/** pi returns tool output as {content:[{type:"text",text}]}. Flatten for the trace. */
export function flatten(result: unknown): string | undefined {
  const parts = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(parts)) return clip(result, TRACE_RESULT);
  const text = (parts as ContentPart[]).map((c) => c?.text ?? `[${c?.type ?? "?"}]`).join("\n");
  return clip(text, TRACE_RESULT);
}
