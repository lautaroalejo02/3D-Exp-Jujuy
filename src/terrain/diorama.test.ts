import { describe, expect, it } from "vitest";

import { elevationToWorldY } from "../geo/world";
import {
  basePlaneKm,
  CONTEXT_LIFT_KM,
  contextBaseKm,
  cutWallTopKm,
  OUTSIDE_FLATTEN,
  rimWallTopKm,
  slabTopKm,
  wallBottomKm,
} from "./context-flatten";
import { dioramaVertexPlan } from "./diorama";
import { Heightfield } from "./heightfield";

const SPEC = {
  zoom: 10,
  originPx: [0, 0],
  width: 4,
  height: 4,
  scale: 1,
} as const;

describe("dioramaVertexPlan", () => {
  it("counts 6 vertices per wall quad on every edge", () => {
    // Edges N and S hold (meshW-1) quads each; W and E hold (meshH-1).
    const plan = dioramaVertexPlan([608, 640]);
    expect(plan.vertexCount).toBe(12 * 607 + 12 * 639);
  });

  it("is one slab top quad plus one rim quad per edge", () => {
    expect(dioramaVertexPlan([4, 4]).slabVertexCount).toBe(30);
  });

  it("counts 6 vertices per outline segment on the cut wall", () => {
    const plan = dioramaVertexPlan([4, 4], 137);
    expect(plan.cutWallVertexCount).toBe(137 * 6);
  });

  it("rejects degenerate meshes like the grid-uniforms builder", () => {
    expect(() => dioramaVertexPlan([1, 4])).toThrow(/2x2/);
    expect(() => dioramaVertexPlan([4, 0])).toThrow(/2x2/);
  });
});

/**
 * The wall/slab alignment contract the shaders implement (diorama.wgsl
 * twins of these helpers): the province-outline wall's top edge is the
 * terrain surface at the outline point, and BOTH wall bottoms sit on
 * the same plane as the slab top — basePlaneKm. The 1.04 slab margin
 * that produced the visible step is gone (slab is flush).
 */
describe("wall/slab alignment", () => {
  const heights = Float32Array.from([
    100, 200, 300, 400,
    150, 250, 350, 450,
    120, 220, 320, 420,
    110, 210, 310, 410,
  ]);
  const hf = new Heightfield(heights, { ...SPEC });
  const exag = 3;

  it("cut wall top equals the terrain edge height at every point", () => {
    for (const [gi, gj] of [
      [0, 0],
      [3, 0],
      [0, 3],
      [3, 3],
      [1.37, 2.11],
      [2.5, 0.25],
    ] as const) {
      const h = hf.heightAtGrid(gi, gj);
      expect(cutWallTopKm(h, exag)).toBe(elevationToWorldY(h, exag));
    }
  });

  it("wall bottoms and the slab top share one base plane exactly", () => {
    const min = hf.min;
    expect(wallBottomKm(min, exag)).toBe(slabTopKm(min, exag));
    expect(wallBottomKm(min, exag)).toBe(basePlaneKm(min, exag));
    // The flattened context plain floats just above that plane.
    expect(contextBaseKm(min, exag)).toBeCloseTo(
      basePlaneKm(min, exag) + CONTEXT_LIFT_KM,
    );
  });

  it("rim wall top is the flattened context height at the grid edge", () => {
    const h = hf.heightAtGrid(0, 1.5);
    expect(rimWallTopKm(h, hf.min, exag)).toBeCloseTo(
      contextBaseKm(hf.min, exag) +
        elevationToWorldY(h, exag) * OUTSIDE_FLATTEN,
    );
  });
});
