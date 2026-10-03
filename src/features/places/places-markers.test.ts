import { describe, expect, it } from "vitest";

import { OrbitCamera } from "../../camera/camera";
import { gridToWorld, type GridSpec } from "../../geo";
import { Heightfield } from "../../terrain/heightfield";
import {
  declutterLabels,
  isOccluded,
  projectToScreen,
} from "./places-markers";

const SPEC: GridSpec = {
  zoom: 10,
  originPx: [0, 0],
  width: 16,
  height: 16,
  scale: 1,
};

function wallHeightfield(): Heightfield {
  // Flat sea-level terrain with a 10 km wall along column i=8.
  const heights = new Float32Array(16 * 16);
  for (let j = 0; j < 16; j++) heights[j * 16 + 8] = 10000;
  return new Heightfield(heights, SPEC);
}

describe("projectToScreen", () => {
  const camera = new OrbitCamera({
    target: [0, 0, 0],
    distanceKm: 100,
    azimuthDeg: 0,
    elevationDeg: 45,
    fovDeg: 45,
    aspect: 800 / 600,
  });

  it("projects the camera target to the viewport center", () => {
    const p = projectToScreen(camera.viewProjectionMatrix(), [0, 0, 0], [
      800, 600,
    ]);
    expect(p).toBeDefined();
    expect(p?.x).toBeCloseTo(400, 1);
    expect(p?.y).toBeCloseTo(300, 1);
  });

  it("returns undefined for points behind the camera", () => {
    const eye = camera.eye();
    // Beyond the camera, along the eye->target direction reversed.
    const behind: [number, number, number] = [
      eye[0] + (eye[0] - 0),
      eye[1] + (eye[1] - 0),
      eye[2] + (eye[2] - 0),
    ];
    expect(
      projectToScreen(camera.viewProjectionMatrix(), behind, [800, 600]),
    ).toBeUndefined();
  });

  it("still projects in-front points outside the viewport", () => {
    const p = projectToScreen(
      camera.viewProjectionMatrix(),
      [10000, 0, 0],
      [800, 600],
    );
    expect(p).toBeDefined();
    expect(p?.x).toBeGreaterThan(800);
  });
});

describe("isOccluded", () => {
  const hf = wallHeightfield();
  const eye = gridToWorld(SPEC, 4, 8, {
    elevationMeters: 6000,
    verticalExaggeration: 1,
  });

  it("hides a marker a tall ridge blocks", () => {
    const marker = gridToWorld(SPEC, 12, 8, {
      elevationMeters: 0,
      verticalExaggeration: 1,
    });
    expect(isOccluded(hf, eye, marker, 1)).toBe(true);
  });

  it("shows a marker on the near side of the ridge", () => {
    const marker = gridToWorld(SPEC, 6, 8, {
      elevationMeters: 0,
      verticalExaggeration: 1,
    });
    expect(isOccluded(hf, eye, marker, 1)).toBe(false);
  });

  it("shows a marker on open flat terrain", () => {
    const flat = new Heightfield(new Float32Array(16 * 16), SPEC);
    const marker = gridToWorld(SPEC, 12, 8, {
      elevationMeters: 0,
      verticalExaggeration: 1,
    });
    expect(isOccluded(flat, eye, marker, 1)).toBe(false);
  });

  it("shows a marker the ray reaches after passing over the ridge", () => {
    // Eye at 6 km, marker at 16 km: at the wall (i=8, midpoint) the ray
    // is at 11 km — above the 10 km ridge, so the marker is visible.
    const marker = gridToWorld(SPEC, 12, 8, {
      elevationMeters: 16000,
      verticalExaggeration: 1,
    });
    expect(isOccluded(hf, eye, marker, 1)).toBe(false);
  });
});

describe("declutterLabels", () => {
  const rect = (x: number, y: number, w = 10, h = 10) => ({
    x,
    y,
    width: w,
    height: h,
  });

  it("keeps every label when nothing overlaps", () => {
    expect(declutterLabels([rect(0, 0), rect(100, 0), rect(200, 0)])).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("hides the label that overlaps an earlier one", () => {
    expect(declutterLabels([rect(0, 0), rect(5, 5)])).toEqual([true, false]);
  });

  it("keeps a label that only overlaps a hidden one", () => {
    // rect 2 overlaps rect 1 (hidden) but not rect 0: it stays visible.
    expect(
      declutterLabels([rect(0, 0), rect(5, 5), rect(100, 0)]),
    ).toEqual([true, false, true]);
  });

  it("honors the gap: rects within gapPx of each other count as overlap", () => {
    // 1 px of separation is inside the default 4 px gap.
    expect(declutterLabels([rect(0, 0), rect(11, 0)])).toEqual([true, false]);
    expect(declutterLabels([rect(0, 0), rect(11, 0)], 0)).toEqual([
      true,
      true,
    ]);
  });
});
