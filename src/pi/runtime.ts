import { join } from "node:path";
import {
  createAgentSessionServices,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { AGENT_DIR } from "../config.js";

/**
 * pi's model runtime is expensive to build and safe to share, so every delegate on this
 * server resolves models through the same instance.
 */
let runtimePromise: Promise<ModelRuntime> | undefined;

export function getRuntime(): Promise<ModelRuntime> {
  runtimePromise ??= createAgentSessionServices({
    cwd: process.cwd(),
    agentDir: AGENT_DIR,
    resourceLoaderOptions: {
      // Load only the provider extension Pi needs for Antigravity models. Loading every
      // user extension here would run unrelated extension setup in the MCP server.
      additionalExtensionPaths: [
        join(AGENT_DIR, "npm", "node_modules", "pi-antigravity", "src", "index.ts"),
      ],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    },
  }).then((services) => services.modelRuntime);
  return runtimePromise;
}

/** A model as pi's runtime describes it. */
export type PiModel = Awaited<ReturnType<ModelRuntime["getAvailable"]>>[number];
