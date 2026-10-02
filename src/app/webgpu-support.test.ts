import { describe, expect, it } from "vitest";

import { checkWebGpuSupport } from "./webgpu-support";

describe("checkWebGpuSupport", () => {
  it("reports api-missing when navigator.gpu is absent", async () => {
    const result = await checkWebGpuSupport({});
    expect(result).toEqual({ supported: false, reason: "api-missing" });
  });

  it("reports adapter-unavailable when requestAdapter resolves null", async () => {
    const result = await checkWebGpuSupport({
      gpu: { requestAdapter: () => Promise.resolve(null) },
    });
    expect(result).toEqual({ supported: false, reason: "adapter-unavailable" });
  });

  it("reports adapter-request-failed when requestAdapter rejects", async () => {
    const result = await checkWebGpuSupport({
      gpu: {
        requestAdapter: () => Promise.reject(new Error("dawn exploded")),
      },
    });
    expect(result.supported).toBe(false);
    if (!result.supported) {
      expect(result.reason).toBe("adapter-request-failed");
      expect(result.detail).toContain("dawn exploded");
    }
  });

  it("reports supported when an adapter is returned", async () => {
    const adapter = {} as GPUAdapter;
    const result = await checkWebGpuSupport({
      gpu: { requestAdapter: () => Promise.resolve(adapter) },
    });
    expect(result).toEqual({ supported: true });
  });
});
