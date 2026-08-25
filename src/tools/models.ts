import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { modelScope, scopedModels } from "../pi/models.js";
import { gated, json } from "./shared.js";

export function registerModels(server: McpServer): void {
  gated(
    server,
    "models",
    {
      description:
        "List models this delegate may use: pi's own scoped set plus any custom provider. " +
        "Use to pick a `model` value.",
      inputSchema: {
        filter: z.string().optional(),
        cwd: z.string().optional().describe("Picks up a project-local pi model scope"),
      },
    },
    async ({ filter, cwd }) => {
      const all = (await scopedModels(cwd)).map((m) => m.ref);
      const hits = filter ? all.filter((s) => s.toLowerCase().includes(filter.toLowerCase())) : all;
      return json({ count: hits.length, scoped: Boolean(modelScope(cwd)), models: hits.slice(0, 200) });
    },
  );
}
