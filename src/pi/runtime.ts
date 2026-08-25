import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * pi's model runtime is expensive to build and safe to share, so every delegate on this
 * server resolves models through the same instance.
 */
let runtimePromise: Promise<ModelRuntime> | undefined;

export function getRuntime(): Promise<ModelRuntime> {
  runtimePromise ??= ModelRuntime.create();
  return runtimePromise;
}

/** A model as pi's runtime describes it. */
export type PiModel = Awaited<ReturnType<ModelRuntime["getAvailable"]>>[number];
