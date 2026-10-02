import { describe, expect, it } from "vitest";

import { DEM_GRID } from "../geo/jujuy";
import { gridToWorld } from "../geo/world";
import {
  buildTerrainGridUniforms,
  meshVertexToGrid,
  shaderWorldPosition,
} from "./terrain-uniforms";

const MESH: readonly [number, number] = [608, 640];

describe("terrain grid uniforms", () => {
  const u = buildTerrainGridUniforms(DEM_GRID, MESH);

  it("rejects meshes smaller than 2x2 vertices", () => {
    expect(() => buildTerrainGridUniforms(DEM_GRID, [1, 10])).toThrow();
    expect(() => buildTerrainGridUniforms(DEM_GRID, [0, 0])).toThrow();
  });

  it("the shader world-mapping matches gridToWorld for grid samples", () => {
    // The formula the WGSL vertex shader evaluates must produce the exact
    // same world positions as src/geo's gridToWorld.
    const samples = [
      [-0.5, -0.5],
      [0, 0],
      [1215.5, 1279.5],
      [2431, 2559],
      [DEM_GRID.width - 0.5, DEM_GRID.height - 0.5],
    ] as const;
    for (const [i, j] of samples) {
      const shader = shaderWorldPosition(u, i, j, 4000, 2.5);
      const cpu = gridToWorld(DEM_GRID, i, j, {
        elevationMeters: 4000,
        verticalExaggeration: 2.5,
      });
      expect(shader[0]).toBeCloseTo(cpu[0], 9);
      expect(shader[1]).toBeCloseTo(cpu[1], 9);
      expect(shader[2]).toBeCloseTo(cpu[2], 9);
    }
  });

  it("mesh vertices span the full grid extent: borders at -0.5 and w-0.5", () => {
    const [westI] = meshVertexToGrid(u, 0, 0);
    const [, northJ] = meshVertexToGrid(u, 0, 0);
    const [eastI, southJ] = meshVertexToGrid(u, MESH[0] - 1, MESH[1] - 1);
    expect(westI).toBeCloseTo(-0.5, 12);
    expect(northJ).toBeCloseTo(-0.5, 12);
    expect(eastI).toBeCloseTo(DEM_GRID.width - 0.5, 12);
    expect(southJ).toBeCloseTo(DEM_GRID.height - 0.5, 12);
  });

  it("mesh corner world positions match the grid corners", () => {
    const corners = [
      [0, 0],
      [MESH[0] - 1, 0],
      [0, MESH[1] - 1],
      [MESH[0] - 1, MESH[1] - 1],
      [300, 320],
    ] as const;
    for (const [mi, mj] of corners) {
      const [gi, gj] = meshVertexToGrid(u, mi, mj);
      const shader = shaderWorldPosition(u, gi, gj, 0, 1);
      const cpu = gridToWorld(DEM_GRID, gi, gj);
      expect(shader[0]).toBeCloseTo(cpu[0], 9);
      expect(shader[2]).toBeCloseTo(cpu[2], 9);
    }
  });

  it("cellKm agrees with metersPerGridCell over the spec scale", () => {
    const half = buildTerrainGridUniforms(
      { ...DEM_GRID, width: 1216, height: 1280, scale: 2 },
      MESH,
    );
    expect(half.cellKm).toBeCloseTo(u.cellKm * 2, 12);
    expect(half.kmPerPx).toBeCloseTo(u.kmPerPx, 12);
  });
});
