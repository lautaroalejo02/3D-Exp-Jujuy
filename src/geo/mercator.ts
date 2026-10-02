/**
 * Web Mercator (EPSG:3857) projection on the sphere, radius 6378137 m.
 * Coordinates in meters, origin at lon 0 / lat 0, x east, y north.
 */

export const MERCATOR_RADIUS = 6378137;

/** Full circumference used by the projection: 2 * pi * R meters. */
export const EARTH_CIRCUMFERENCE = 2 * Math.PI * MERCATOR_RADIUS;

/** Maximum latitude representable in Web Mercator. */
export const MAX_MERCATOR_LAT = 85.0511287798066;

const DEG = Math.PI / 180;

export function lonLatToMercator(lon: number, lat: number): readonly [number, number] {
  const clamped = Math.min(Math.max(lat, -MAX_MERCATOR_LAT), MAX_MERCATOR_LAT);
  const phi = clamped * DEG;
  return [MERCATOR_RADIUS * lon * DEG, MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + phi / 2))];
}

export function mercatorToLonLat(x: number, y: number): readonly [number, number] {
  return [x / MERCATOR_RADIUS / DEG, Math.atan(Math.sinh(y / MERCATOR_RADIUS)) / DEG];
}

/**
 * Ratio between ground distance and Mercator meters at a latitude.
 * Mercator stretches local distances by 1/cos(lat), so ground = mercator * cos(lat).
 */
export function mercatorGroundScale(lat: number): number {
  return Math.cos(lat * DEG);
}

export { DEG };
