import { describe, expect, it } from "vitest";

import {
  cameraInDrawDistance,
  detailSatelliteDivisor,
  nextDetailSiteStatus,
  type DetailSiteEvent,
  type DetailSiteStatus,
} from "./detail-load";

const ALL_STATUSES: readonly DetailSiteStatus[] = [
  "idle",
  "requested",
  "loading",
  "ready",
  "failed",
];

const reduce = (status: DetailSiteStatus, event: DetailSiteEvent) =>
  nextDetailSiteStatus(status, event);

describe("nextDetailSiteStatus", () => {
  it("walks idle -> requested -> loading -> ready", () => {
    let s: DetailSiteStatus = "idle";
    s = reduce(s, "camera-in-range");
    expect(s).toBe("requested");
    s = reduce(s, "load-start");
    expect(s).toBe("loading");
    s = reduce(s, "load-ok");
    expect(s).toBe("ready");
  });

  it("walks the failure branch: loading -> failed", () => {
    let s: DetailSiteStatus = "idle";
    s = reduce(s, "camera-in-range");
    s = reduce(s, "load-start");
    s = reduce(s, "load-fail");
    expect(s).toBe("failed");
  });

  it("ignores repeated camera-in-range events while queued/loading/failed", () => {
    for (const status of ALL_STATUSES) {
      if (status === "idle" || status === "ready") continue;
      expect(reduce(status, "camera-in-range")).toBe(status);
    }
  });

  it("re-requests a ready site (payload warm, GPU evicted)", () => {
    // A site whose payload survived an eviction only needs the GPU side
    // back — it goes through the same requested -> loading -> ready walk.
    let s: DetailSiteStatus = "ready";
    s = reduce(s, "camera-in-range");
    expect(s).toBe("requested");
    s = reduce(s, "load-start");
    expect(s).toBe("loading");
    s = reduce(s, "load-ok");
    expect(s).toBe("ready");
  });

  it("release drops requested and ready back to idle", () => {
    expect(reduce("requested", "release")).toBe("idle");
    expect(reduce("ready", "release")).toBe("idle");
    // A released site re-requests cleanly on the next selection.
    let s = reduce("ready", "release");
    s = reduce(s, "camera-in-range");
    expect(s).toBe("requested");
  });

  it("release is a no-op while idle, loading or failed", () => {
    expect(reduce("idle", "release")).toBe("idle");
    // In-flight loads are not released mid-flight — the job re-checks
    // the selection after its await and releases itself if un-wanted.
    expect(reduce("loading", "release")).toBe("loading");
    expect(reduce("failed", "release")).toBe("failed");
  });

  it("ignores out-of-order loader events", () => {
    expect(reduce("idle", "load-start")).toBe("idle");
    expect(reduce("idle", "load-ok")).toBe("idle");
    expect(reduce("idle", "load-fail")).toBe("idle");
    expect(reduce("requested", "load-ok")).toBe("requested");
    expect(reduce("requested", "load-fail")).toBe("requested");
    expect(reduce("ready", "load-start")).toBe("ready");
    expect(reduce("failed", "load-start")).toBe("failed");
  });

  it("keeps failed terminal — a failed site never retries", () => {
    expect(reduce("ready", "load-fail")).toBe("ready");
    expect(reduce("failed", "load-ok")).toBe("failed");
    // Re-entering the draw distance after a failure stays disabled.
    expect(reduce(reduce("failed", "camera-in-range"), "load-start")).toBe(
      "failed",
    );
  });
});

describe("cameraInDrawDistance", () => {
  it("is true inside the threshold and false outside", () => {
    // eye 3-4-5 km from the patch center on the ground plane.
    expect(cameraInDrawDistance(3, 4, 0, 0, 6)).toBe(true);
    expect(cameraInDrawDistance(3, 4, 0, 0, 5)).toBe(false);
    expect(cameraInDrawDistance(3, 4, 0, 0, 4)).toBe(false);
  });

  it("measures ground-plane distance only (eye height ignored)", () => {
    // Callers pass eye[0]/eye[2]; at the same x/z a high camera is still
    // "in range" — the check is deliberately 2D.
    expect(cameraInDrawDistance(10, 0, 0, 0, 20)).toBe(true);
  });
});

describe("detailSatelliteDivisor", () => {
  it("halves the patch satellite on mobile, keeps it on desktop", () => {
    expect(detailSatelliteDivisor("mobile")).toBe(2);
    expect(detailSatelliteDivisor("desktop")).toBe(1);
  });
});
