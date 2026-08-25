import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DIR, IGNORE_SCOPE, STRICT_SCOPE } from "../config.js";
import type { ModelScope } from "../types.js";
import { getRuntime, type PiModel } from "./runtime.js";

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * The delegate may only use models pi itself has scoped, plus anything served by a
 * custom provider from models.json, since those are declared by hand and are the point of
 * having a custom provider at all.
 *
 * Mirrors pi's settings precedence: project `<cwd>/.pi/settings.json` overrides global.
 * An empty or missing enabledModels means no scoping, matching pi's own no-op default.
 */
export function modelScope(cwd?: string): ModelScope | undefined {
  if (IGNORE_SCOPE) return undefined;
  const global = readJson(join(AGENT_DIR, "settings.json"))?.enabledModels;
  const local = cwd ? readJson(join(cwd, ".pi", "settings.json"))?.enabledModels : undefined;
  const enabled = local ?? global;
  if (!Array.isArray(enabled) || enabled.length === 0) return undefined;

  const providers = readJson(join(AGENT_DIR, "models.json"))?.providers;
  const customProviders =
    STRICT_SCOPE || !providers || typeof providers !== "object" ? [] : Object.keys(providers);
  return { enabled: new Set(enabled as string[]), customProviders: new Set(customProviders) };
}

export function inScope(scope: ModelScope | undefined, provider: string, id: string): boolean {
  if (!scope) return true;
  return scope.customProviders.has(provider) || scope.enabled.has(`${provider}/${id}`);
}

export interface ScopedModel {
  provider: string;
  id: string;
  ref: string;
}

/**
 * Models the delegate can actually use: in scope AND backed by a provider that is
 * authenticated. A scoped model with no credentials is not usable, so it is not offered.
 */
export async function scopedModels(cwd?: string): Promise<ScopedModel[]> {
  const scope = modelScope(cwd);
  const rt = await getRuntime();
  const available = await rt.getAvailable();
  return available
    .map((m) => ({ provider: m.provider, id: m.id, ref: `${m.provider}/${m.id}` }))
    .filter((m) => inScope(scope, m.provider, m.id));
}

export interface Health {
  available: number;
  usable: string[];
}

/**
 * Refuse to operate at all when pi is absent or unusable. A delegate server that
 * silently degrades is worse than one that will not start.
 */
export async function preflight(cwd?: string): Promise<Health> {
  if (!existsSync(AGENT_DIR))
    throw new Error(
      `pi is not configured: ${AGENT_DIR} does not exist. Install pi ` +
        `(npm i -g @earendil-works/pi-coding-agent), run \`pi\` once, and \`/login\` a provider.`,
    );

  const rt = await getRuntime();
  const runtimeError = rt.getError();
  if (runtimeError) throw new Error(`pi's model runtime failed to load: ${runtimeError}`);

  const available = await rt.getAvailable();
  if (available.length === 0)
    throw new Error(
      `pi has no authenticated provider. Run \`pi\` and \`/login\`, or put an API key in ` +
        `${join(AGENT_DIR, "auth.json")}. Environment variables are unreliable here because MCP ` +
        `hosts launch servers with a stripped environment.`,
    );

  const usable = await scopedModels(cwd);
  if (usable.length === 0) {
    const scope = modelScope(cwd);
    throw new Error(
      scope
        ? `No usable model. pi's enabledModels scope [${[...scope.enabled].join(", ")}] does not ` +
          `intersect any authenticated provider. Widen it via pi's /scoped-models, log in to the ` +
          `matching provider, or set PI_DELEGATE_IGNORE_SCOPE=1.`
        : "No usable model: pi reports authenticated providers but none carry a usable model.",
    );
  }
  return { available: available.length, usable: usable.map((m) => m.ref) };
}

/**
 * Resolve "provider/modelId" to a model. Splits on the FIRST slash so
 * "openrouter/stealth/ox-alpha" yields provider=openrouter, id=stealth/ox-alpha.
 *
 * Throws on a miss. pi silently falls back to the default model when handed
 * `undefined`, which is how you end up billing a model you never asked for.
 */
export async function resolveModel(spec: string | undefined, cwd?: string): Promise<PiModel | undefined> {
  if (!spec) return undefined;
  const rt = await getRuntime();
  const slash = spec.indexOf("/");
  let model: PiModel | undefined;
  if (slash > 0) model = rt.getModel(spec.slice(0, slash), spec.slice(slash + 1));
  model ??= rt.getModels().find((m) => m.id === spec);

  if (!model)
    throw new Error(
      `Model not found: ${spec}. Use "provider/modelId", e.g. "openrouter/stealth/ox-alpha". ` +
        `Call the "models" tool to list what is available.`,
    );

  const scope = modelScope(cwd);
  if (!inScope(scope, model.provider, model.id)) {
    const allowed = (await scopedModels(cwd)).map((m) => m.ref);
    throw new Error(
      `Model ${model.provider}/${model.id} is out of scope. Allowed here: ${allowed.join(", ")}. ` +
        `Widen it in pi's own settings (enabledModels, via /scoped-models) or set ` +
        `PI_DELEGATE_IGNORE_SCOPE=1 on this server.`,
    );
  }
  return model;
}
