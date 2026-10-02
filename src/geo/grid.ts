import {
  globalPixelToLonLat,
  lonLatToGlobalPixel,
} from "./slippy";

/**
 * A grid of samples over a window of slippy-map global pixels.
 *
 * `originPx` is the global pixel coordinate (at `zoom`) of the grid's
 * top-left (north-west) corner. Grid sample (i, j) sits at the CENTER of a
 * `scale` x `scale` block of source pixels, i.e. at global pixel
 * (originPx.x + (i + 0.5) * scale, originPx.y + (j + 0.5) * scale).
 *
 * `scale` is 1 for native tile resolution. Downsampling does not change
 * `zoom` or `originPx` — it only enlarges `scale` and shrinks
 * `width`/`height`, so every derived coordinate stays in the same global
 * pixel space and a downsampled spec covers (at least) the same extent.
 */
export interface GridSpec {
  readonly zoom: number;
  readonly originPx: readonly [number, number];
  /** Cell count along x (west to east). */
  readonly width: number;
  /** Cell count along y (north to south). */
  readonly height: number;
  /** Source pixels per cell; 1 = full resolution. */
  readonly scale: number;
}

export function gridToGlobalPixel(
  spec: GridSpec,
  i: number,
  j: number,
): readonly [number, number] {
  return [
    spec.originPx[0] + (i + 0.5) * spec.scale,
    spec.originPx[1] + (j + 0.5) * spec.scale,
  ];
}

export function globalPixelToGrid(
  spec: GridSpec,
  px: number,
  py: number,
): readonly [number, number] {
  return [
    (px - spec.originPx[0]) / spec.scale - 0.5,
    (py - spec.originPx[1]) / spec.scale - 0.5,
  ];
}

export function lonLatToGrid(
  spec: GridSpec,
  lon: number,
  lat: number,
): readonly [number, number] {
  const [px, py] = lonLatToGlobalPixel(lon, lat, spec.zoom);
  return globalPixelToGrid(spec, px, py);
}

export function gridToLonLat(
  spec: GridSpec,
  i: number,
  j: number,
): readonly [number, number] {
  const [px, py] = gridToGlobalPixel(spec, i, j);
  return globalPixelToLonLat(px, py, spec.zoom);
}

/** Grid extent in global pixels: [left, top, right, bottom]. */
export function gridExtentGlobalPixels(
  spec: GridSpec,
): readonly [number, number, number, number] {
  return [
    spec.originPx[0],
    spec.originPx[1],
    spec.originPx[0] + spec.width * spec.scale,
    spec.originPx[1] + spec.height * spec.scale,
  ];
}

/** Grid extent in degrees: [west, south, east, north]. */
export function gridExtentLonLat(
  spec: GridSpec,
): readonly [number, number, number, number] {
  const [left, top, right, bottom] = gridExtentGlobalPixels(spec);
  const [west, north] = globalPixelToLonLat(left, top, spec.zoom);
  const [east, south] = globalPixelToLonLat(right, bottom, spec.zoom);
  return [west, south, east, north];
}

/**
 * Whether grid coordinates fall inside the covered extent: the grid covers
 * i in [-0.5, width - 0.5] and j in [-0.5, height - 0.5].
 */
export function gridContains(spec: GridSpec, i: number, j: number): boolean {
  return (
    i >= -0.5 && i <= spec.width - 0.5 && j >= -0.5 && j <= spec.height - 0.5
  );
}

/**
 * Half-resolution for factor 2, quarter for 4, etc. `zoom` and `originPx`
 * are unchanged — coarser cells are expressed by a larger `scale`.
 * `width`/`height` use ceil so the downsampled grid still covers the whole
 * original extent (edge cells may cover a partial block).
 */
export function downsampleGrid(spec: GridSpec, factor: number): GridSpec {
  return {
    zoom: spec.zoom,
    originPx: spec.originPx,
    width: Math.ceil(spec.width / factor),
    height: Math.ceil(spec.height / factor),
    scale: spec.scale * factor,
  };
}
