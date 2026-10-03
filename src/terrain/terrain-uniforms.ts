import {
  gridCenterGlobalPixel,
  groundMetersPerPixel,
  metersPerGridCell,
  type GridSpec,
} from "../geo";

/**
 * Static uniform values for terrain.wgsl, all derived from src/geo so the
 * shader implements exactly gridToWorld semantics: X east, Z south, Y up,
 * kilometers of ground distance, Y = elevationMeters / 1000 * exaggeration.
 *
 * The mesh covers the full grid extent: mesh vertex (0, 0) sits on the
 * north-west BORDER of the DEM (grid coordinate -0.5) and mesh vertex
 * (meshW-1, meshH-1) on the south-east border (width-0.5, height-0.5).
 * `meshToGrid` is the scale factor: gridCoord = meshVertex * meshToGrid - 0.5.
 */
export interface TerrainGridUniforms {
  /** Global-pixel coordinate of the grid's north-west corner. */
  readonly originPx: readonly [number, number];
  /** Global-pixel coordinate of the grid center (world origin). */
  readonly centerPx: readonly [number, number];
  /** Height grid size in cells [width, height]. */
  readonly gridSize: readonly [number, number];
  /** Mesh size in vertices [width, height]. */
  readonly meshSize: readonly [number, number];
  /** Grid cells per mesh step: meshVertex * meshToGrid - 0.5 = gridCoord. */
  readonly meshToGrid: readonly [number, number];
  /** Ground kilometers per global pixel at the grid zoom. */
  readonly kmPerPx: number;
  /** Global pixels per height-grid cell (GridSpec.scale). */
  readonly cellScale: number;
  /** Ground kilometers per height-grid cell. */
  readonly cellKm: number;
}

/**
 * Atmospheric haze ramp, shared by terrain.wgsl and diorama.wgsl as
 * uniforms. The ramp is expressed as a multiple of the camera-to-target
 * orbit distance, not an absolute km value: at the default framing the
 * visible block ends well inside 1.5x the orbit distance, so a start at
 * 1.6x leaves the overview completely clear, and haze only ever touches
 * the far rim the user sees at grazing angles. The haze color lives in
 * the shaders — it must match the sky's horizon color.
 */
export const HAZE_START_DISTANCE_FACTOR = 1.6;
export const HAZE_END_DISTANCE_FACTOR = 2.6;

/** [start, end] of the haze ramp in km, for the given orbit distance. */
export function hazeRangeKm(
  distanceKm: number,
): readonly [number, number] {
  return [
    distanceKm * HAZE_START_DISTANCE_FACTOR,
    distanceKm * HAZE_END_DISTANCE_FACTOR,
  ];
}

export function buildTerrainGridUniforms(
  spec: GridSpec,
  meshSize: readonly [number, number],
): TerrainGridUniforms {
  if (meshSize[0] < 2 || meshSize[1] < 2) {
    throw new Error(
      `terrain mesh needs at least 2x2 vertices, got ${meshSize[0]}x${meshSize[1]}`,
    );
  }
  return {
    originPx: [spec.originPx[0], spec.originPx[1]],
    centerPx: [
      gridCenterGlobalPixel(spec)[0],
      gridCenterGlobalPixel(spec)[1],
    ],
    gridSize: [spec.width, spec.height],
    meshSize: [meshSize[0], meshSize[1]],
    meshToGrid: [
      spec.width / (meshSize[0] - 1),
      spec.height / (meshSize[1] - 1),
    ],
    kmPerPx: groundMetersPerPixel(spec) / 1000,
    cellScale: spec.scale,
    cellKm: metersPerGridCell(spec) / 1000,
  };
}

/**
 * JavaScript twin of the vertex shader's world-mapping formula. Kept next to
 * the uniform builder so a unit test can assert that the GPU math equals
 * gridToWorld from src/geo. Do not re-derive this inside shaders or tests.
 */
export function shaderWorldPosition(
  u: TerrainGridUniforms,
  gridI: number,
  gridJ: number,
  elevationMeters: number,
  verticalExaggeration: number,
): readonly [number, number, number] {
  const px = u.originPx[0] + (gridI + 0.5) * u.cellScale;
  const py = u.originPx[1] + (gridJ + 0.5) * u.cellScale;
  return [
    (px - u.centerPx[0]) * u.kmPerPx,
    (elevationMeters / 1000) * verticalExaggeration,
    (py - u.centerPx[1]) * u.kmPerPx,
  ];
}

/** Grid coordinate of a mesh vertex (the mapping the vertex shader uses). */
export function meshVertexToGrid(
  u: TerrainGridUniforms,
  meshI: number,
  meshJ: number,
): readonly [number, number] {
  return [
    meshI * u.meshToGrid[0] - 0.5,
    meshJ * u.meshToGrid[1] - 0.5,
  ];
}
