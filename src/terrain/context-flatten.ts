import { bilinearSample } from "./raster";

/**
 * Hybrid diorama presentation — the pure math shared by the renderer
 * (terrain.wgsl, diorama.wgsl, shadow.wgsl, detail.wgsl twins) and the
 * CPU picking surface (picking/detail-pick.ts):
 *
 * - Inside the province (SDF >= 0) terrain keeps its full relief.
 * - Outside, the drawn height is pulled down toward a low context plain:
 *   drawnY_km = contextBaseKm + worldY_km * OUTSIDE_FLATTEN.
 * - Both skirt walls and the slab top sit on ONE base plane,
 *   basePlaneKm() — the single source for the wall-bottom/slab-top
 *   alignment the diorama tests assert.
 *
 * Everything is pure: no GPU, no DOM. The WGSL twins repeat each formula
 * inline with a comment pointing here.
 */

/** Depth of the base plane below the exaggerated minimum elevation, km. */
export const SKIRT_KM = 10;
/** Thickness of the plinth slab under the base plane, km. */
export const SLAB_KM = 2.2;
/**
 * Slab half-extents as a fraction of the terrain footprint. 1.0 = flush:
 * the slab top never protrudes past the rim wall, which is what produced
 * the visible step between the skirt and the plinth.
 */
export const SLAB_MARGIN = 1.0;
/** Width of the soft contact-shadow ring on the slab top, km. */
export const SHADOW_KM = 14;
/** Share of the relief kept outside the province (task asks 15–25%). */
export const OUTSIDE_FLATTEN = 0.2;
/** The flattened context plain floats this far above the base plane, km. */
export const CONTEXT_LIFT_KM = 0.6;

/**
 * The base plane: the ONE horizontal reference the walls and the slab
 * share. Wall bottoms and the slab top are exactly this value — the
 * diorama tests assert both equal it.
 */
export function basePlaneKm(
  minElevationMeters: number,
  verticalExaggeration: number,
): number {
  return (minElevationMeters / 1000) * verticalExaggeration - SKIRT_KM;
}

/** World-space Y the flattened context plain sits at, km. */
export function contextBaseKm(
  minElevationMeters: number,
  verticalExaggeration: number,
): number {
  return basePlaneKm(minElevationMeters, verticalExaggeration) + CONTEXT_LIFT_KM;
}

/**
 * Drawn world-space Y for an outside point whose unflattened world height
 * is `worldYkm` — WGSL twin of the `if (sdf < 0)` branch in the terrain /
 * diorama / detail / shadow shaders.
 */
export function flattenedWorldY(
  worldYkm: number,
  minElevationMeters: number,
  verticalExaggeration: number,
): number {
  return (
    contextBaseKm(minElevationMeters, verticalExaggeration) +
    worldYkm * OUTSIDE_FLATTEN
  );
}

/**
 * Virtual elevation in METERS that lands an outside point at its drawn
 * height: elevationToWorldY(flattenedMeters(m), exag) equals
 * flattenedWorldY(elevationToWorldY(m), exag). Feeding this into the
 * picking/marker surface keeps every meter->km converter unchanged.
 * Can go negative for low terrain — it is a coordinate, not a datum.
 */
export function flattenedMeters(
  meters: number,
  minElevationMeters: number,
  verticalExaggeration: number,
): number {
  return (
    (contextBaseKm(minElevationMeters, verticalExaggeration) * 1000) /
      verticalExaggeration +
    meters * OUTSIDE_FLATTEN
  );
}

/**
 * How far (meters) the virtual drawn surface may dip below
 * heightfield.min outside the province — the clip-box margin pick and
 * occlusion marches must add to the box's lower bound.
 */
export function flattenMarginMeters(
  minElevationMeters: number,
  verticalExaggeration: number,
): number {
  return Math.max(
    0,
    minElevationMeters -
      flattenedMeters(minElevationMeters, minElevationMeters, verticalExaggeration),
  );
}

/**
 * Grid coords (i, j) of the height grid mapped into the SDF raster's own
 * coords — both grids cover the same ground extent, so it is a pure
 * scale between cell-center conventions (identity when sizes match).
 */
export function heightGridToSdfGrid(
  i: number,
  j: number,
  gridWidth: number,
  gridHeight: number,
  sdfWidth: number,
  sdfHeight: number,
): readonly [number, number] {
  return [
    ((i + 0.5) * sdfWidth) / gridWidth - 0.5,
    ((j + 0.5) * sdfHeight) / gridHeight - 0.5,
  ];
}

/**
 * Bilinear sample of the Int8 province SDF at SDF-grid coords — the CPU
 * twin of textureSample(provinceSdfTex, linearSampler, uv).r * 255 - 127.
 * Positive inside Jujuy, negative outside; 0 is the boundary.
 */
export function provinceSdfAt(
  sdf: ArrayLike<number>,
  sdfWidth: number,
  sdfHeight: number,
  si: number,
  sj: number,
): number {
  return bilinearSample(sdf, sdfWidth, sdfHeight, si, sj);
}

/**
 * The flattening inputs at one place: the province SDF raster plus the
 * grid it covers and the relief floor it flattens toward.
 */
export interface ContextFlatten {
  /** Int8 province SDF in cells, row-major, + inside / - outside. */
  readonly sdf: ArrayLike<number>;
  readonly sdfWidth: number;
  readonly sdfHeight: number;
  /** Height-grid size the SDF covers (same ground extent). */
  readonly gridWidth: number;
  readonly gridHeight: number;
  /** Minimum DEM elevation in meters (heightfield.min). */
  readonly minElevationMeters: number;
  /** Live getter so the surface tracks the exaggeration slider. */
  readonly verticalExaggeration: () => number;
}

/**
 * Whether grid coords (i, j) sit inside the province — the CPU twin of
 * `sdf >= 0` after the shader's bilinear SDF sample. Points outside the
 * raster bounds read as outside.
 */
export function provinceInside(
  ctx: ContextFlatten,
  i: number,
  j: number,
): boolean {
  const [si, sj] = heightGridToSdfGrid(
    i,
    j,
    ctx.gridWidth,
    ctx.gridHeight,
    ctx.sdfWidth,
    ctx.sdfHeight,
  );
  return provinceSdfAt(ctx.sdf, ctx.sdfWidth, ctx.sdfHeight, si, sj) >= 0;
}

/**
 * CPU twin of the terrain vertex shader's drawn height, expressed in
 * meters: inside the province the raw DEM sample, outside the virtual
 * meters whose elevationToWorldY lands on the flattened context.
 */
export function drawnMetersAt(
  ctx: ContextFlatten,
  meters: number,
  i: number,
  j: number,
): number {
  if (provinceInside(ctx, i, j)) return meters;
  return flattenedMeters(
    meters,
    ctx.minElevationMeters,
    ctx.verticalExaggeration(),
  );
}

/**
 * Wall alignment contract — the TS twins of the Y coordinates the diorama
 * shaders emit, so the test can assert the topology without a GPU:
 * - cutWallTopKm: the province-outline wall's top edge is exactly the
 *   unflattened drawn surface at the boundary (the boundary itself is
 *   inside the flatten mask), matching the terrain mesh heights it
 *   meets;
 * - rimWallTopKm: the outer rim's top edge is the FLATTENED context
 *   surface at the rectangular grid edge;
 * - wallBottomKm = slabTopKm = basePlaneKm for both walls — one shared
 *   plane, no step.
 */
export function cutWallTopKm(
  heightMeters: number,
  verticalExaggeration: number,
): number {
  return (heightMeters / 1000) * verticalExaggeration;
}

export function rimWallTopKm(
  heightMeters: number,
  minElevationMeters: number,
  verticalExaggeration: number,
): number {
  return flattenedWorldY(
    cutWallTopKm(heightMeters, verticalExaggeration),
    minElevationMeters,
    verticalExaggeration,
  );
}

export function wallBottomKm(
  minElevationMeters: number,
  verticalExaggeration: number,
): number {
  return basePlaneKm(minElevationMeters, verticalExaggeration);
}

export function slabTopKm(
  minElevationMeters: number,
  verticalExaggeration: number,
): number {
  return basePlaneKm(minElevationMeters, verticalExaggeration);
}
