import { DEG, EARTH_CIRCUMFERENCE, MAX_MERCATOR_LAT } from "./mercator";

/**
 * Slippy-map global pixel coordinates: at integer `zoom` the world is a
 * square of `256 * 2^zoom` pixels. Pixel (0, 0) is the top-left corner:
 * lon -180 / lat +85.05112878. y grows southward.
 */

export const TILE_SIZE = 256;

export function globalPixelCount(zoom: number): number {
  return TILE_SIZE * 2 ** zoom;
}

export function lonLatToGlobalPixel(
  lon: number,
  lat: number,
  zoom: number,
): readonly [number, number] {
  const n = globalPixelCount(zoom);
  const clamped = Math.min(Math.max(lat, -MAX_MERCATOR_LAT), MAX_MERCATOR_LAT);
  const px = ((lon + 180) / 360) * n;
  const py = ((1 - Math.asinh(Math.tan(clamped * DEG)) / Math.PI) / 2) * n;
  return [px, py];
}

export function globalPixelToLonLat(
  px: number,
  py: number,
  zoom: number,
): readonly [number, number] {
  const n = globalPixelCount(zoom);
  const lon = (px / n) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / n))) / DEG;
  return [lon, lat];
}

/** Mercator meters covered by one global pixel at `zoom`. */
export function mercatorMetersPerPixel(zoom: number): number {
  return EARTH_CIRCUMFERENCE / globalPixelCount(zoom);
}

export function globalPixelToMercator(
  px: number,
  py: number,
  zoom: number,
): readonly [number, number] {
  const n = globalPixelCount(zoom);
  return [(px / n - 0.5) * EARTH_CIRCUMFERENCE, (0.5 - py / n) * EARTH_CIRCUMFERENCE];
}

export function mercatorToGlobalPixel(
  x: number,
  y: number,
  zoom: number,
): readonly [number, number] {
  const n = globalPixelCount(zoom);
  return [(x / EARTH_CIRCUMFERENCE + 0.5) * n, (0.5 - y / EARTH_CIRCUMFERENCE) * n];
}
