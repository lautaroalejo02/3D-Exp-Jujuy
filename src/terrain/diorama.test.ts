import { describe, expect, it } from "vitest";

import { dioramaVertexPlan } from "./diorama";

describe("dioramaVertexPlan", () => {
  it("counts 6 vertices per wall quad on every edge", () => {
    // Edges N and S hold (meshW-1) quads each; W and E hold (meshH-1).
    const plan = dioramaVertexPlan([608, 640]);
    expect(plan.vertexCount).toBe(12 * 607 + 12 * 639);
  });

  it("is one slab top quad plus one rim quad per edge", () => {
    expect(dioramaVertexPlan([4, 4]).slabVertexCount).toBe(30);
  });

  it("rejects degenerate meshes like the grid-uniforms builder", () => {
    expect(() => dioramaVertexPlan([1, 4])).toThrow(/2x2/);
    expect(() => dioramaVertexPlan([4, 0])).toThrow(/2x2/);
  });
});
