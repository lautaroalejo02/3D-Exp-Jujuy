import {
  globalPixelToGrid,
  gridContains,
  type GridSpec,
} from "../geo/grid";
import { mercatorGroundScale } from "../geo/mercator";
import {
  globalPixelToLonLat,
  lonLatToGlobalPixel,
  mercatorMetersPerPixel,
} from "../geo/slippy";
import { decodeHeightsLE } from "./encoding";
import { TERRAIN_SCHEMA_VERSION, type TerrainManifest } from "./manifest";
import { bilinearSample } from "./raster";

/** Quality levels offered by the terrain manifest. */
export type TerrainQuality = "default" | "high";

/** Minimal fetch contract so tests can inject a stub. */
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type FetchLike = (url: string) => Promise<FetchResponseLike>;

const defaultFetch: FetchLike = (url) => fetch(url);

export class TerrainHttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`HTTP ${status} fetching ${url}`);
    this.name = "TerrainHttpError";
  }
}

export class TerrainManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerrainManifestError";
  }
}

export interface ProfileSample {
  readonly lon: number;
  readonly lat: number;
  /** Cumulative ground distance from `a`, in meters. */
  readonly distanceMeters: number;
  /** Bilinear DEM height; undefined when the sample falls off the grid. */
  readonly elevationMeters: number | undefined;
}

/**
 * A sampled elevation grid over a GridSpec. Heights live in meters; sample
 * (i, j) sits at the center of grid cell (i, j), matching src/geo.
 */
export class Heightfield {
  readonly min: number;
  readonly max: number;
  private readonly heights: Float32Array;

  constructor(
    heights: Int16Array | Float32Array,
    readonly spec: GridSpec,
  ) {
    const expected = spec.width * spec.height;
    if (heights.length !== expected) {
      throw new Error(
        `Heightfield data length ${heights.length} does not match spec ${spec.width}x${spec.height}`,
      );
    }
    this.heights =
      heights instanceof Float32Array ? heights : Float32Array.from(heights);
    let min = Infinity;
    let max = -Infinity;
    for (const h of this.heights) {
      if (h < min) min = h;
      if (h > max) max = h;
    }
    this.min = min;
    this.max = max;
  }

  get width(): number {
    return this.spec.width;
  }

  get height(): number {
    return this.spec.height;
  }

  /** Bilinear sample at fractional grid coords, clamped to the borders. */
  heightAtGrid(i: number, j: number): number {
    return bilinearSample(
      this.heights,
      this.spec.width,
      this.spec.height,
      i,
      j,
    );
  }

  /** Bilinear height at a geographic position; undefined off the grid. */
  heightAtLonLat(lon: number, lat: number): number | undefined {
    const [px, py] = lonLatToGlobalPixel(lon, lat, this.spec.zoom);
    const [i, j] = globalPixelToGrid(this.spec, px, py);
    if (!gridContains(this.spec, i, j)) return undefined;
    return this.heightAtGrid(i, j);
  }

  /**
   * n samples evenly spaced (in Web Mercator global pixels) between lon/lat
   * points a and b. `distanceMeters` is cumulative GROUND distance: Mercator
   * steps are corrected by cos(lat) of each step's midpoint. This is the
   * base for the elevation-profile feature.
   */
  sampleAlong(
    a: readonly [number, number],
    b: readonly [number, number],
    n: number,
  ): ProfileSample[] {
    if (n < 1) return [];
    const zoom = this.spec.zoom;
    const [ax, ay] = lonLatToGlobalPixel(a[0], a[1], zoom);
    const [bx, by] = lonLatToGlobalPixel(b[0], b[1], zoom);
    const metersPerPixel = mercatorMetersPerPixel(zoom);

    const samples: ProfileSample[] = [];
    let distance = 0;
    let prevPx = ax;
    let prevPy = ay;
    let prevLat = a[1];
    for (let k = 0; k < n; k++) {
      const t = n === 1 ? 0 : k / (n - 1);
      const px = ax + (bx - ax) * t;
      const py = ay + (by - ay) * t;
      const [lon, lat] = globalPixelToLonLat(px, py, zoom);
      if (k > 0) {
        const mercatorStep =
          Math.hypot(px - prevPx, py - prevPy) * metersPerPixel;
        distance += mercatorStep * mercatorGroundScale((lat + prevLat) / 2);
      }
      const [i, j] = globalPixelToGrid(this.spec, px, py);
      samples.push({
        lon,
        lat,
        distanceMeters: distance,
        elevationMeters: gridContains(this.spec, i, j)
          ? this.heightAtGrid(i, j)
          : undefined,
      });
      prevPx = px;
      prevPy = py;
      prevLat = lat;
    }
    return samples;
  }
}

function assertManifest(value: unknown): asserts value is TerrainManifest {
  const m = value as TerrainManifest | null;
  if (
    !m ||
    typeof m !== "object" ||
    m.schemaVersion !== TERRAIN_SCHEMA_VERSION ||
    !m.levels?.default?.heights?.grid ||
    !m.levels?.high?.heights?.grid ||
    typeof m.levels.default.heights.file !== "string" ||
    typeof m.levels.high.heights.file !== "string"
  ) {
    throw new TerrainManifestError(
      "terrain.json is missing or does not match schema version " +
        TERRAIN_SCHEMA_VERSION,
    );
  }
}

/** Fetch and validate terrain.json. Throws TerrainHttpError on HTTP errors. */
export async function loadTerrainManifest(
  fetchFn: FetchLike,
  url = "terrain.json",
): Promise<TerrainManifest> {
  const res = await fetchFn(url);
  if (!res.ok) throw new TerrainHttpError(url, res.status);
  const body: unknown = await res.json();
  assertManifest(body);
  return body;
}

/**
 * Fetch the Int16 height grid for a quality level and build a Heightfield.
 * `baseUrl` prefixes the manifest-relative file names (e.g. the folder
 * terrain.json was loaded from). Throws TerrainHttpError on HTTP errors and
 * a plain Error when the payload size contradicts the manifest grid.
 */
export async function loadHeightfield(
  manifest: TerrainManifest,
  quality: TerrainQuality,
  fetchFn: FetchLike = defaultFetch,
  baseUrl = "",
): Promise<Heightfield> {
  const level = manifest.levels[quality];
  const url = `${baseUrl}${level.heights.file}`;
  const res = await fetchFn(url);
  if (!res.ok) throw new TerrainHttpError(url, res.status);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const heights = decodeHeightsLE(bytes);
  return new Heightfield(heights, level.heights.grid);
}
