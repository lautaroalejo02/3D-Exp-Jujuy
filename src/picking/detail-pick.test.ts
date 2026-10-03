import { describe, expect, it } from "vitest";

import type { GridSpec } from "../geo/grid";
import {
  detailPatchRectBaseGrid,
  patchBaseGridMap,
} from "../terrain/detail-grids";
import { Heightfield } from "../terrain/heightfield";
import {
  baseMeshElevation,
  detailSurfaceElevation,
  type BaseMeshSurface,
  type DetailPickPatch,
} from "./detail-pick";

// A small base grid. Heights are chosen so mesh quad (0,0) — with
// meshToGrid = [2,2] — is NOT planar: three corners at 0 m and one at
// 100 m, which is exactly the case where the drawn triangle surface
// differs from the raw bilinear heightfield.
const BASE_SPEC: GridSpec = {
  zoom: 10,
  originPx: [82048, 147200],
  width: 16,
  height: 8,
  scale: 1,
};

function baseHeights(): Float32Array {
  const h = new Float32Array(BASE_SPEC.width * BASE_SPEC.height);
  for (const [i, j] of [
    [1, 1],
    [2, 1],
    [1, 2],
    [2, 2],
  ] as const) {
    h[j * BASE_SPEC.width + i] = 100;
  }
  return h;
}

const MESH_TO_GRID: readonly [number, number] = [2, 2];

function baseSurface(): BaseMeshSurface {
  return {
    heightfield: new Heightfield(baseHeights(), BASE_SPEC),
    meshToGrid: MESH_TO_GRID,
  };
}

// Patch covering base grid coords i in [2.5, 10.5], j in [1.5, 5.5]:
// z12 origin = 12 z12-px right + 8 z12-px down of the base origin.
const PATCH_SPEC: GridSpec = {
  zoom: 12,
  originPx: [4 * 82048 + 12, 4 * 147200 + 8],
  width: 32,
  height: 16,
  scale: 1,
};
const PATCH_HEIGHT = 500;
const EDGE_FADE = 0.05;

function patch(): DetailPickPatch {
  const heights = new Float32Array(PATCH_SPEC.width * PATCH_SPEC.height);
  heights.fill(PATCH_HEIGHT);
  return {
    id: "p",
    rect: detailPatchRectBaseGrid(PATCH_SPEC, BASE_SPEC),
    gridMap: patchBaseGridMap(PATCH_SPEC, BASE_SPEC),
    heightfield: new Heightfield(heights, PATCH_SPEC),
    edgeFade: EDGE_FADE,
  };
}

describe("baseMeshElevation", () => {
  const base = baseSurface();

  it("reproduces the drawn triangle, not the bilinear field", () => {
    // Center of mesh quad (0,0): corners 0/0/0/100. The drawn surface is
    // the diagonal between the two triangles → 0. Raw bilinear gives 25.
    expect(baseMeshElevation(base, 0.5, 0.5)).toBe(0);
    expect(base.heightfield.heightAtGrid(0.5, 0.5)).toBe(25);
  });

  it("interpolates the lower-right triangle for fx + fy > 1", () => {
    // bi=1.1, bj=0.5 -> mesh cell (0.8, 0.5): fx+fy = 1.3 > 1.
    // h11=100, h10=h01=0 -> 100 - 100*(0.5) - 100*(0.2) = 30.
    expect(baseMeshElevation(base, 1.1, 0.5)).toBeCloseTo(30, 6);
  });

  it("matches the base heightfield exactly at mesh vertices", () => {
    // Mesh vertex (1,1) sits at grid coord (1.5, 1.5) — the 100 m corner.
    expect(baseMeshElevation(base, 1.5, 1.5)).toBe(100);
    // Vertex (1,0) at (1.5, -0.5) — the flat corner.
    expect(baseMeshElevation(base, 1.5, -0.5)).toBe(0);
  });
});

describe("detailSurfaceElevation", () => {
  const base = baseSurface();
  const p = patch();

  it("returns the base bilinear height outside the patch rect", () => {
    expect(detailSurfaceElevation(base, [p], 2.0, 2.0)).toBe(
      base.heightfield.heightAtGrid(2.0, 2.0),
    );
    expect(detailSurfaceElevation(base, [p], 12.0, 6.0)).toBe(
      base.heightfield.heightAtGrid(12.0, 6.0),
    );
  });

  it("coincides with the base drawn surface at the rect edge (w = 0)", () => {
    // On the left rect edge (bi = 2.5) the morph weight is 0, so the
    // reported elevation is exactly the base-mesh surface — the same
    // continuity the shader produces at the patch border.
    for (const bj of [1.5, 3.5, 5.5]) {
      expect(detailSurfaceElevation(base, [p], 2.5, bj)).toBeCloseTo(
        baseMeshElevation(base, 2.5, bj),
        6,
      );
    }
  });

  it("returns the pure patch height inside the faded band (w = 1)", () => {
    // Patch center: bi=6.5 -> gi=15.5, bj=3.5 -> gj=7.5 (u=v=0.5).
    expect(detailSurfaceElevation(base, [p], 6.5, 3.5)).toBe(PATCH_HEIGHT);
  });

  it("blends with the smoothstep weight inside the fade band", () => {
    // u = edgeFade/2 -> w = 0.5. bi=2.7 -> gi=0.3 -> u=0.025; bj=3.5 is
    // deep inside (v=0.5) so the band edge is the u side.
    const baseE = baseMeshElevation(base, 2.7, 3.5);
    expect(baseE).toBe(0); // flat part of the fixture
    expect(detailSurfaceElevation(base, [p], 2.7, 3.5)).toBeCloseTo(
      (baseE + PATCH_HEIGHT) / 2,
      6,
    );
  });
});
