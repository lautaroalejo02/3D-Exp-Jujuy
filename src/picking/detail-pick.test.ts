import { describe, expect, it } from "vitest";

import type { GridSpec } from "../geo/grid";
import {
  detailPatchCenterBaseGrid,
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
const SPLIT_BAND = 8;

function patch(): DetailPickPatch {
  const heights = new Float32Array(PATCH_SPEC.width * PATCH_SPEC.height);
  heights.fill(PATCH_HEIGHT);
  return {
    id: "p",
    rect: detailPatchRectBaseGrid(PATCH_SPEC, BASE_SPEC),
    center: detailPatchCenterBaseGrid(PATCH_SPEC, BASE_SPEC),
    gridMap: patchBaseGridMap(PATCH_SPEC, BASE_SPEC),
    heightfield: new Heightfield(heights, PATCH_SPEC),
    edgeFade: EDGE_FADE,
  };
}

// A second patch shifted 4 base cells east: rect [6.5, 1.5, 14.5, 5.5],
// center (10.5, 3.5) — overlapping patch P's [2.5, 1.5, 10.5, 5.5] on
// i in [6.5, 10.5], with the Voronoi bisector at bi = 8.5.
const PATCH_B_SPEC: GridSpec = {
  ...PATCH_SPEC,
  originPx: [4 * 82048 + 12 + 16, 4 * 147200 + 8],
};
const PATCH_B_HEIGHT = 700;

function patchB(): DetailPickPatch {
  const heights = new Float32Array(PATCH_B_SPEC.width * PATCH_B_SPEC.height);
  heights.fill(PATCH_B_HEIGHT);
  return {
    id: "p2",
    rect: detailPatchRectBaseGrid(PATCH_B_SPEC, BASE_SPEC),
    center: detailPatchCenterBaseGrid(PATCH_B_SPEC, BASE_SPEC),
    gridMap: patchBaseGridMap(PATCH_B_SPEC, BASE_SPEC),
    heightfield: new Heightfield(heights, PATCH_B_SPEC),
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
    expect(detailSurfaceElevation(base, [p], 2.0, 2.0, SPLIT_BAND)).toBe(
      base.heightfield.heightAtGrid(2.0, 2.0),
    );
    expect(detailSurfaceElevation(base, [p], 12.0, 6.0, SPLIT_BAND)).toBe(
      base.heightfield.heightAtGrid(12.0, 6.0),
    );
  });

  it("coincides with the base drawn surface at the rect edge (w = 0)", () => {
    // On the left rect edge (bi = 2.5) the morph weight is 0, so the
    // reported elevation is exactly the base-mesh surface — the same
    // continuity the shader produces at the patch border.
    for (const bj of [1.5, 3.5, 5.5]) {
      expect(
        detailSurfaceElevation(base, [p], 2.5, bj, SPLIT_BAND),
      ).toBeCloseTo(baseMeshElevation(base, 2.5, bj), 6);
    }
  });

  it("returns the pure patch height inside the faded band (w = 1)", () => {
    // Patch center: bi=6.5 -> gi=15.5, bj=3.5 -> gj=7.5 (u=v=0.5).
    expect(detailSurfaceElevation(base, [p], 6.5, 3.5, SPLIT_BAND)).toBe(
      PATCH_HEIGHT,
    );
  });

  it("blends with the smoothstep weight inside the fade band", () => {
    // u = edgeFade/2 -> w = 0.5. bi=2.7 -> gi=0.3 -> u=0.025; bj=3.5 is
    // deep inside (v=0.5) so the band edge is the u side.
    const baseE = baseMeshElevation(base, 2.7, 3.5);
    expect(baseE).toBe(0); // flat part of the fixture
    expect(
      detailSurfaceElevation(base, [p], 2.7, 3.5, SPLIT_BAND),
    ).toBeCloseTo((baseE + PATCH_HEIGHT) / 2, 6);
  });
});

describe("detailSurfaceElevation overlap (Voronoi split)", () => {
  const base = baseSurface();
  const a = patch(); // center (6.5, 3.5), height 500
  const b = patchB(); // center (10.5, 3.5), height 700

  it("the nearer patch owns the point", () => {
    // bi=9.5 is inside both rects; dA=3, dB=1 -> B owns. margin 2 ->
    // splitW = smoothstep(0, 8, 2) = 0.15625; B is deep inside its own
    // edge band there (u = 12/32 -> edgeW = 1).
    const expected = PATCH_B_HEIGHT * 0.15625;
    expect(
      detailSurfaceElevation(base, [a, b], 9.5, 3.5, SPLIT_BAND),
    ).toBeCloseTo(expected, 6);
  });

  it("the lower list index wins the exact bisector", () => {
    // bi=8.5: equidistant to both centers; patch A (index 0) owns it and
    // morphs to the base surface (margin ~0 -> w ~0). Reversed list
    // order must hand the same pixel to B — deterministic either way.
    const own = detailSurfaceElevation(base, [a, b], 8.5, 3.5, SPLIT_BAND);
    const rev = detailSurfaceElevation(base, [b, a], 8.5, 3.5, SPLIT_BAND);
    const baseE = baseMeshElevation(base, 8.5, 3.5);
    expect(own).toBeCloseTo(baseE, 2); // owner sits at ~w=0
    expect(rev).toBeCloseTo(baseE, 2);
  });

  it("a point covered by one patch only ignores the split", () => {
    // bi=13 is inside B alone (outside A's rect): full B height.
    expect(detailSurfaceElevation(base, [a, b], 13, 3.5, SPLIT_BAND)).toBe(
      PATCH_B_HEIGHT,
    );
  });

  it("surface is continuous across the seam", () => {
    // Elevation just left and just right of the bisector must agree:
    // both sides morph toward the base surface, so the split cannot open
    // a crack.
    const left = detailSurfaceElevation(base, [a, b], 8.4, 3.5, SPLIT_BAND);
    const right = detailSurfaceElevation(
      base,
      [a, b],
      8.6,
      3.5,
      SPLIT_BAND,
    );
    expect(Math.abs(left - right)).toBeLessThan(50);
  });
});
