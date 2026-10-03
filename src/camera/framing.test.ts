import { describe, expect, it } from "vitest";

import type { GridSpec } from "../geo/grid";
import { gridToWorld } from "../geo/world";
import { transformPoint, type OrbitCamera } from "./camera";
import { bboxOnGrid, overviewCamera } from "./framing";

/**
 * The default-quality grid and the province mask bounds, taken from
 * terrain.json's `levels.default.departments` (pipeline v3). Kept here as
 * plain fixtures — the pipeline owns the real numbers.
 */
const SPEC: GridSpec = {
  zoom: 10,
  originPx: [82048, 147200],
  width: 1216,
  height: 1280,
  scale: 2,
};

/** Jujuy's provinceBBoxGrid on the default grid (inclusive cell bounds). */
const PROVINCE_BBOX: readonly [number, number, number, number] = [
  40, 64, 1155, 1186,
];

const RELIEF = {
  maxElevationMeters: 6131,
  verticalExaggeration: 2.5,
};

/**
 * Every corner of the region's bounding box — cell borders, not centers —
 * at ground level and at the exaggerated relief top. If the camera frames
 * the region, all of these project inside the NDC cube.
 */
function regionCorners(
  bbox: readonly [number, number, number, number],
  reliefKm: number,
): [number, number, number][] {
  const [minI, minJ, maxI, maxJ] = bbox;
  const corners: [number, number, number][] = [];
  for (const j of [minJ - 0.5, maxJ + 0.5]) {
    for (const i of [minI - 0.5, maxI + 0.5]) {
      for (const h of [0, reliefKm]) {
        corners.push([...gridToWorld(SPEC, i, j)] as [number, number, number]);
        corners[corners.length - 1]![1] = h;
      }
    }
  }
  return corners;
}

function projectedToNdc(
  camera: OrbitCamera,
  p: readonly [number, number, number],
): readonly [number, number, number] {
  return transformPoint(camera.viewProjectionMatrix(), p);
}

describe("overviewCamera", () => {
  it("frames a grid-cell region in landscape so all corners fit the NDC", () => {
    const aspect = 1280 / 800;
    const camera = overviewCamera(SPEC, aspect, RELIEF, {
      region: { bboxGrid: PROVINCE_BBOX },
    });
    expect(camera.elevationDeg).toBe(45);
    const reliefKm = (RELIEF.maxElevationMeters / 1000) * RELIEF.verticalExaggeration;
    for (const corner of regionCorners(PROVINCE_BBOX, reliefKm)) {
      const [x, y, z] = projectedToNdc(camera, corner);
      expect(Math.abs(x), `ndc x of ${corner}`).toBeLessThanOrEqual(1);
      expect(Math.abs(y), `ndc y of ${corner}`).toBeLessThanOrEqual(1);
      // Reversed-Z: finite scene points map to (0, 1].
      expect(z, `ndc z of ${corner}`).toBeGreaterThan(0);
      expect(z).toBeLessThanOrEqual(1);
    }
  });

  it("looks due north from the south in portrait so the tall axis uses screen height", () => {
    const aspect = 390 / 844;
    const camera = overviewCamera(SPEC, aspect, RELIEF, {
      region: { bboxGrid: PROVINCE_BBOX },
    });
    expect(camera.azimuthDeg).toBe(0);
    // Portrait framing sits lower (40°) than landscape (45°): the relief
    // reads in 3D from the start instead of a near top-down view.
    expect(camera.elevationDeg).toBe(40);
    const reliefKm = (RELIEF.maxElevationMeters / 1000) * RELIEF.verticalExaggeration;
    for (const corner of regionCorners(PROVINCE_BBOX, reliefKm)) {
      const [x, y, z] = projectedToNdc(camera, corner);
      expect(Math.abs(x), `ndc x of ${corner}`).toBeLessThanOrEqual(1);
      expect(Math.abs(y), `ndc y of ${corner}`).toBeLessThanOrEqual(1);
      expect(z).toBeGreaterThan(0);
      expect(z).toBeLessThanOrEqual(1);
    }
  });

  it("still frames the whole grid when no region is given", () => {
    const aspect = 1280 / 800;
    const camera = overviewCamera(SPEC, aspect, RELIEF);
    const grid: readonly [number, number, number, number] = [
      0,
      0,
      SPEC.width - 1,
      SPEC.height - 1,
    ];
    const reliefKm = (RELIEF.maxElevationMeters / 1000) * RELIEF.verticalExaggeration;
    for (const corner of regionCorners(grid, reliefKm)) {
      const [x, y] = projectedToNdc(camera, corner);
      expect(Math.abs(x)).toBeLessThanOrEqual(1);
      expect(Math.abs(y)).toBeLessThanOrEqual(1);
    }
  });
});

describe("bboxOnGrid", () => {
  it("is the identity when the grids coincide", () => {
    expect(bboxOnGrid(SPEC, SPEC, PROVINCE_BBOX)).toEqual(PROVINCE_BBOX);
  });

  it("halves the cell indices on a 2x-downsampled grid", () => {
    // Same extent at half resolution: half the cells, double the scale.
    const coarse: GridSpec = { ...SPEC, width: 608, height: 640, scale: 4 };
    const [i0, j0, i1, j1] = bboxOnGrid(coarse, SPEC, PROVINCE_BBOX);
    // Cell borders map exactly: fine cells 40..1155 and 64..1186 cover the
    // same ground as coarse cells 20..577 and 32..593.
    expect(i0).toBeCloseTo(20);
    expect(j0).toBeCloseTo(32);
    expect(i1).toBeCloseTo(577);
    expect(j1).toBeCloseTo(593);
  });
});
