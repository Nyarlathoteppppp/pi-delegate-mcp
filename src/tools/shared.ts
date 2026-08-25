import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";

/** Every tool answers with pretty JSON, so a human reading the transcript can follow it. */
export const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

let initialised = false;

export const markInitialised = (): void => {
  initialised = true;
};

/** Every tool but `init` refuses until the caller has read the operating instructions. */
function requireInit(): void {
  if (!initialised)
    throw new Error(
      "Call `init` first. It reports the models available here, the tools this server permits, " +
        "and how to drive a delegate. One call, then everything else unlocks.",
    );
}

export interface ToolMeta<A extends ZodRawShape> {
  description: string;
  inputSchema: A;
}

/**
 * Register a tool that is unavailable until `init` has run. Going through this wrapper
 * rather than repeating the check means a tool added later cannot forget the gate.
 */
export function gated<A extends ZodRawShape>(
  server: McpServer,
  name: string,
  meta: ToolMeta<A>,
  handler: ToolCallback<A>,
): void {
  // The SDK's ToolCallback is an overloaded generic that does not survive being wrapped,
  // so the indirection is erased here. The handler stays fully typed at its call site.
  const call = handler as unknown as (...a: unknown[]) => unknown;
  const guarded = ((...args: unknown[]) => {
    requireInit();
    return call(...args);
  }) as unknown as ToolCallback<A>;
  server.registerTool(name, meta, guarded);
}
