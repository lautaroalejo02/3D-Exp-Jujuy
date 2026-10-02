import {
  globalPixelToGrid,
  gridToGlobalPixel,
  gridToLonLat,
  lonLatToGrid,
  type GridSpec,
} from "./grid";
import { mercatorGroundScale } from "./mercator";
import { globalPixelToLonLat, mercatorMetersPerPixel } from "./slippy";

/**
 * World space for the 3D scene: right-handed, Y up, X east, Z south (grid
 * rows grow southward, matching +Z). Origin is the grid center. The unit is
 * one KILOMETER of ground distance.
 *
 * Ground distance is approximated by scaling Mercator meters with
 * cos(centerLat) — a single constant factor for the whole grid, since
 * Mercator distortion varies with latitude. Across the Jujuy grid
 * (~21.6°S to ~24.8°S) the true factor varies by roughly 2%, so distances
 * near the north/south edges carry that order of error. Conformality keeps
 * the same factor valid on both axes.
 *
 * Heights: y = elevationMeters / 1000 * verticalExaggeration.
 */

export interface HeightOptions {
  /** Terrain height above sea level, meters. Default 0 (base plane). */
  readonly elevationMeters?: number;
  /** Vertical exaggeration multiplier. Default 1. */
  readonly verticalExaggeration?: number;
}

/** Global pixel coordinate of the grid center. */
export function gridCenterGlobalPixel(spec: GridSpec): readonly [number, number] {
  return [
    spec.originPx[0] + (spec.width * spec.scale) / 2,
    spec.originPx[1] + (spec.height * spec.scale) / 2,
  ];
}

/** Ground meters per global pixel at the grid's zoom and center latitude. */
export function groundMetersPerPixel(spec: GridSpec): number {
  const [cx, cy] = gridCenterGlobalPixel(spec);
  const [, centerLat] = globalPixelToLonLat(cx, cy, spec.zoom);
  return mercatorMetersPerPixel(spec.zoom) * mercatorGroundScale(centerLat);
}

/** Ground meters covered by one grid cell (same on both axes). */
export function metersPerGridCell(spec: GridSpec): number {
  return groundMetersPerPixel(spec) * spec.scale;
}

export function elevationToWorldY(elevationMeters: number, verticalExaggeration: number): number {
  return (elevationMeters / 1000) * verticalExaggeration;
}

export function gridToWorld(
  spec: GridSpec,
  i: number,
  j: number,
  height: HeightOptions = {},
): readonly [number, number, number] {
  const [px, py] = gridToGlobalPixel(spec, i, j);
  const [cx, cy] = gridCenterGlobalPixel(spec);
  const kmPerPx = groundMetersPerPixel(spec) / 1000;
  return [
    (px - cx) * kmPerPx,
    elevationToWorldY(height.elevationMeters ?? 0, height.verticalExaggeration ?? 1),
    (py - cy) * kmPerPx,
  ];
}

/** Inverse of gridToWorld on the ground plane; the y component is ignored. */
export function worldToGrid(
  spec: GridSpec,
  x: number,
  z: number,
): readonly [number, number] {
  const [cx, cy] = gridCenterGlobalPixel(spec);
  const kmPerPx = groundMetersPerPixel(spec) / 1000;
  return globalPixelToGrid(spec, x / kmPerPx + cx, z / kmPerPx + cy);
}

export function lonLatToWorld(
  spec: GridSpec,
  lon: number,
  lat: number,
  height: HeightOptions = {},
): readonly [number, number, number] {
  const [i, j] = lonLatToGrid(spec, lon, lat);
  return gridToWorld(spec, i, j, height);
}

export function worldToLonLat(
  spec: GridSpec,
  x: number,
  z: number,
): readonly [number, number] {
  const [i, j] = worldToGrid(spec, x, z);
  return gridToLonLat(spec, i, j);
}
