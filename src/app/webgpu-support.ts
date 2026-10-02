/**
 * Pure WebGPU capability detection. Takes a navigator-like object instead of
 * the global `navigator` so it can be unit-tested without a DOM.
 */

export interface GpuLike {
  requestAdapter(): Promise<GPUAdapter | null>;
}

export interface NavigatorLike {
  readonly gpu?: GpuLike;
}

export type WebGpuSupport =
  | { readonly supported: true }
  | {
      readonly supported: false;
      readonly reason: "api-missing" | "adapter-unavailable" | "adapter-request-failed";
      readonly detail?: string;
    };

export async function checkWebGpuSupport(navigatorLike: NavigatorLike): Promise<WebGpuSupport> {
  if (!navigatorLike.gpu) {
    return { supported: false, reason: "api-missing" };
  }
  let adapter: GPUAdapter | null;
  try {
    adapter = await navigatorLike.gpu.requestAdapter();
  } catch (error) {
    return {
      supported: false,
      reason: "adapter-request-failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (adapter === null) {
    return { supported: false, reason: "adapter-unavailable" };
  }
  return { supported: true };
}
