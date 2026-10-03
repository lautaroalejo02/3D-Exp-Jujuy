import { describe, expect, it } from "vitest";

import { OrbitCamera } from "../../camera/camera";
import { MAX_DETAIL_PATCHES } from "../../terrain/detail-grids";
import {
  chooseDetailEvictions,
  DETAIL_LIVE_PATCH_BUDGET,
  detailBudgetPeakBytes,
  detailLivePatchBudget,
  detailPatchGpuBytes,
  detailPatchInFrustum,
  selectLiveDetailPatches,
} from "./detail-budget";

describe("DETAIL_LIVE_PATCH_BUDGET", () => {
  it("gives mobile 3 and desktop 8 live patches", () => {
    expect(detailLivePatchBudget("mobile")).toBe(3);
    expect(detailLivePatchBudget("desktop")).toBe(8);
    expect(DETAIL_LIVE_PATCH_BUDGET).toEqual({ mobile: 3, desktop: 8 });
  });

  it("fits the shader arbitration arrays (MAX_DETAIL_PATCHES)", () => {
    // The largest profile budget is what the patchRects/patchCenters
    // uniform arrays in terrain.wgsl and detail.wgsl are sized for.
    expect(Math.max(...Object.values(DETAIL_LIVE_PATCH_BUDGET))).toBe(
      MAX_DETAIL_PATCHES,
    );
  });
});

describe("selectLiveDetailPatches", () => {
  const candidates = [
    { id: "far", distanceKm: 90, inFrustum: true },
    { id: "near", distanceKm: 10, inFrustum: true },
    { id: "behind", distanceKm: 5, inFrustum: false },
    { id: "mid", distanceKm: 40, inFrustum: true },
  ];

  it("selects the nearest in-frustum candidates up to the budget", () => {
    expect(selectLiveDetailPatches(candidates, 8)).toEqual([
      "near",
      "mid",
      "far",
    ]);
    expect(selectLiveDetailPatches(candidates, 2)).toEqual(["near", "mid"]);
  });

  it("never selects out-of-frustum sites even under budget", () => {
    // "behind" is nearest but not on screen: it must not take a slot.
    expect(selectLiveDetailPatches(candidates, 1)).toEqual(["near"]);
  });

  it("is deterministic on distance ties", () => {
    const tied = [
      { id: "b", distanceKm: 10, inFrustum: true },
      { id: "a", distanceKm: 10, inFrustum: true },
    ];
    expect(selectLiveDetailPatches(tied, 2)).toEqual(["a", "b"]);
  });

  it("returns an empty selection for no candidates", () => {
    expect(selectLiveDetailPatches([], 8)).toEqual([]);
  });
});

describe("chooseDetailEvictions", () => {
  it("evicts only non-wanted residents, farthest first", () => {
    const residents = [
      { id: "keep-near", distanceKm: 10, lastUsed: 1, wanted: true },
      { id: "keep-far", distanceKm: 90, lastUsed: 1, wanted: true },
      { id: "evict-mid", distanceKm: 50, lastUsed: 1, wanted: false },
      { id: "evict-far", distanceKm: 80, lastUsed: 1, wanted: false },
    ];
    // One eviction: the farthest non-wanted resident goes.
    expect(chooseDetailEvictions(residents, 1)).toEqual(["evict-far"]);
    // Two: both non-wanted, farthest first.
    expect(chooseDetailEvictions(residents, 2)).toEqual([
      "evict-far",
      "evict-mid",
    ]);
  });

  it("breaks distance ties by least-recently-used", () => {
    const residents = [
      { id: "recent", distanceKm: 50, lastUsed: 9, wanted: false },
      { id: "stale", distanceKm: 50, lastUsed: 2, wanted: false },
    ];
    expect(chooseDetailEvictions(residents, 1)).toEqual(["stale"]);
  });

  it("never picks a wanted resident even when excess is larger", () => {
    const residents = [
      { id: "a", distanceKm: 10, lastUsed: 1, wanted: true },
      { id: "b", distanceKm: 90, lastUsed: 1, wanted: true },
    ];
    expect(chooseDetailEvictions(residents, 5)).toEqual([]);
  });

  it("returns nothing when there is no excess", () => {
    const residents = [
      { id: "a", distanceKm: 10, lastUsed: 1, wanted: false },
    ];
    expect(chooseDetailEvictions(residents, 0)).toEqual([]);
    expect(chooseDetailEvictions(residents, -1)).toEqual([]);
  });
});

describe("detailPatchInFrustum", () => {
  // Camera 50 km south of the origin looking north (azimuth 0 puts the
  // eye due south of the target), elevation 45 deg: the origin is dead
  // center of the frustum.
  const camera = new OrbitCamera({
    target: [0, 0, 0],
    distanceKm: 50,
    azimuthDeg: 0,
    elevationDeg: 45,
    fovDeg: 45,
    aspect: 1,
    nearKm: 0.2,
  });
  const vp = camera.viewProjectionMatrix();

  const box = (
    centerX: number,
    centerZ: number,
    halfX = 10,
    halfZ = 10,
    yMinKm = 0,
    yMaxKm = 5,
  ) =>
    detailPatchInFrustum(
      vp,
      centerX,
      centerZ,
      halfX,
      halfZ,
      yMinKm,
      yMaxKm,
    );

  it("sees the patch the camera looks at", () => {
    expect(box(0, 0)).toBe(true);
  });

  it("culls a patch fully behind the camera", () => {
    // Azimuth 0 puts the eye due south (z = +35 km) looking north, so a
    // patch at z = +150 sits behind the view axis.
    expect(box(0, 150)).toBe(false);
  });

  it("culls a patch far off to the side", () => {
    expect(box(500, 0)).toBe(false);
    expect(box(-500, 0)).toBe(false);
  });

  it("sees a patch whose corner enters the frustum even if the center is out", () => {
    // At ~50 km of view distance a 45 deg fov is ~20 km wide at the
    // target depth: a center at x=25 is outside but its near corner at
    // x=15 still intersects; x=40 does not reach.
    expect(box(25, 0, 10, 10)).toBe(true);
    expect(box(45, 0, 5, 5)).toBe(false);
  });
});

describe("detailPatchGpuBytes", () => {
  // A 2304x2304 satellite + 576x576 height grid: the z14 patch shape the
  // pipeline writes for every site.
  const SAT: readonly [number, number] = [2304, 2304];
  const CELLS = 576 * 576;

  it("counts texture mips plus height storage on desktop", () => {
    // textureBytesWithMips(2304, 2304, 4) = ~27.0 MiB; + ~1.3 MiB heights.
    const bytes = detailPatchGpuBytes(SAT, CELLS, "desktop");
    expect(bytes).toBeGreaterThan(28 * 1024 * 1024);
    expect(bytes).toBeLessThan(30 * 1024 * 1024);
  });

  it("uploads a quarter of the texels on mobile", () => {
    const desktop = detailPatchGpuBytes(SAT, CELLS, "desktop");
    const mobile = detailPatchGpuBytes(SAT, CELLS, "mobile");
    // Satellite area /4 (heights unchanged): ~8 MiB versus ~28 MiB.
    expect(mobile).toBeGreaterThan(7 * 1024 * 1024);
    expect(mobile).toBeLessThan(9 * 1024 * 1024);
    expect(mobile).toBeLessThan(desktop / 3);
  });
});

describe("detailBudgetPeakBytes", () => {
  it("sums only the budget's largest footprints", () => {
    // Ten 30 MiB sites + one 40 MiB site: mobile keeps the 3 largest
    // (40+30+30), desktop the 8 largest (40+7x30) — never all eleven.
    const footprints = [...Array(10).fill(30), 40];
    expect(detailBudgetPeakBytes(footprints, "mobile")).toBe(100);
    expect(detailBudgetPeakBytes(footprints, "desktop")).toBe(250);
  });

  it("sums everything when there are fewer sites than the budget", () => {
    expect(detailBudgetPeakBytes([10, 20], "mobile")).toBe(30);
  });
});
