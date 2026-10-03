/**
 * Manifest and client loader for the high-resolution detail patches built
 * by scripts/build-detail.ts into data/build/detail/. Each site is a small
 * window of Sentinel-2 z14 imagery plus Terrarium z12 heights covering
 * exactly the same ground extent, rendered by src/features/detail/.
 *
 * Pure data access — nothing here touches the GPU or the DOM (same
 * contract as departments.ts): callers supply a fetch implementation, and
 * the returned satellite bytes are decoded by the caller (createImageBitmap
 * in the browser, jpeg-js under Node).
 */
import type { GridSpec } from "../geo/grid";
import { decodeHeightsLE } from "./encoding";
import {
  Heightfield,
  TerrainHttpError,
  type FetchLike,
} from "./heightfield";
import type {
  ElevationStats,
  HeightEncoding,
  TerrainFileEntry,
} from "./manifest";
import { assertSameGroundExtent } from "./validate";

const defaultFetch: FetchLike = (url) => fetch(url);

/** detail/manifest.json schema version produced by the pipeline. */
export const DETAIL_SCHEMA_VERSION = 2;

/** Thrown when detail/manifest.json or a payload fails validation. */
export class DetailManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DetailManifestError";
  }
}

/** Geographic source for the site's position, as recorded by the pipeline. */
export interface DetailSiteSource {
  readonly kind: string;
  readonly url: string;
  readonly property: string;
}

/** One detail patch: heights + satellite over the same ground window. */
export interface DetailSite {
  readonly id: string;
  readonly name: string;
  /** Wikidata item id the coordinates came from (e.g. "Q16630587"). */
  readonly wikidata: string;
  readonly lon: number;
  readonly lat: number;
  readonly source: DetailSiteSource;
  readonly heights: TerrainFileEntry & {
    readonly grid: GridSpec;
    readonly encoding: HeightEncoding;
    readonly elevation: ElevationStats;
  };
  readonly satellite: TerrainFileEntry & { readonly grid: GridSpec };
  /** Ground size of the patch in kilometers, [east, south]. */
  readonly sizeKm: readonly [number, number];
}

export interface DetailManifest {
  readonly schemaVersion: number;
  /** Version of the detail pipeline; part of the build cache key. */
  readonly pipelineVersion: number;
  /** sha256 over every raw sources manifest (sources*.json) used. */
  readonly inputSha256: string;
  readonly sites: readonly DetailSite[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertGridSpec(value: unknown, what: string): asserts value is GridSpec {
  const g = value as GridSpec | null;
  if (
    !isRecord(g) ||
    typeof g.zoom !== "number" ||
    !Array.isArray(g.originPx) ||
    g.originPx.length !== 2 ||
    typeof g.originPx[0] !== "number" ||
    typeof g.originPx[1] !== "number" ||
    typeof g.width !== "number" ||
    typeof g.height !== "number" ||
    typeof g.scale !== "number"
  ) {
    throw new DetailManifestError(`${what} is not a GridSpec`);
  }
}

function assertFileEntry(
  value: unknown,
  what: string,
): asserts value is TerrainFileEntry {
  const f = value as TerrainFileEntry | null;
  if (
    !isRecord(f) ||
    typeof f.file !== "string" ||
    typeof f.bytes !== "number" ||
    typeof f.sha256 !== "string"
  ) {
    throw new DetailManifestError(`${what} is not a file entry`);
  }
}

function assertDetailManifest(
  value: unknown,
): asserts value is DetailManifest {
  const m = value as DetailManifest | null;
  if (
    !isRecord(m) ||
    m.schemaVersion !== DETAIL_SCHEMA_VERSION ||
    typeof m.pipelineVersion !== "number" ||
    typeof m.inputSha256 !== "string" ||
    !Array.isArray(m.sites)
  ) {
    throw new DetailManifestError(
      "detail/manifest.json is missing or does not match schema version " +
        DETAIL_SCHEMA_VERSION,
    );
  }
  for (const [k, site] of m.sites.entries()) {
    const what = `detail/manifest.json sites[${k}]`;
    if (
      !isRecord(site) ||
      typeof site.id !== "string" ||
      typeof site.name !== "string" ||
      typeof site.wikidata !== "string" ||
      typeof site.lon !== "number" ||
      typeof site.lat !== "number" ||
      !isRecord(site.source) ||
      typeof site.source.url !== "string" ||
      !Array.isArray(site.sizeKm) ||
      site.sizeKm.length !== 2 ||
      typeof site.sizeKm[0] !== "number" ||
      typeof site.sizeKm[1] !== "number"
    ) {
      throw new DetailManifestError(`${what} is not a valid site entry`);
    }
    const heights: unknown = site.heights;
    const satellite: unknown = site.satellite;
    assertFileEntry(heights, `${what}.heights`);
    assertFileEntry(satellite, `${what}.satellite`);
    const heightsGrid: unknown = (heights as { grid?: unknown }).grid;
    const satelliteGrid: unknown = (satellite as { grid?: unknown }).grid;
    assertGridSpec(heightsGrid, `${what}.heights.grid`);
    assertGridSpec(satelliteGrid, `${what}.satellite.grid`);
    // The satellite is draped over the height grid; equal extents are what
    // make the UV mapping valid.
    assertSameGroundExtent(heightsGrid, satelliteGrid);
  }
}

/**
 * Fetch and validate detail/manifest.json. Throws TerrainHttpError on HTTP
 * errors and DetailManifestError on schema or grid mismatches.
 */
export async function loadDetailManifest(
  fetchFn: FetchLike,
  url = "detail/manifest.json",
): Promise<DetailManifest> {
  const res = await fetchFn(url);
  if (!res.ok) throw new TerrainHttpError(url, res.status);
  const body: unknown = await res.json();
  assertDetailManifest(body);
  return body;
}

/** Decoded heights + raw satellite JPEG bytes for one site. */
export interface DetailSitePayload {
  readonly heightfield: Heightfield;
  /**
   * JPEG payload; the caller decodes it (createImageBitmap or jpeg-js) and
   * must check the decoded size against satellite.grid, which is what
   * assertDetailSatelliteSize does.
   */
  readonly satelliteBytes: Uint8Array<ArrayBuffer>;
}

/**
 * Fetch the Int16 height grid and the satellite JPEG for a site.
 * `baseUrl` prefixes the manifest-relative file names (e.g. "detail/").
 * Throws TerrainHttpError on HTTP errors and DetailManifestError when a
 * payload contradicts the manifest.
 */
export async function loadDetailSite(
  site: DetailSite,
  fetchFn: FetchLike = defaultFetch,
  baseUrl = "detail/",
): Promise<DetailSitePayload> {
  const heightsUrl = `${baseUrl}${site.heights.file}`;
  const satUrl = `${baseUrl}${site.satellite.file}`;
  const [heightsRes, satRes] = await Promise.all([
    fetchFn(heightsUrl),
    fetchFn(satUrl),
  ]);
  if (!heightsRes.ok) throw new TerrainHttpError(heightsUrl, heightsRes.status);
  if (!satRes.ok) throw new TerrainHttpError(satUrl, satRes.status);
  const heightsBytes = new Uint8Array(await heightsRes.arrayBuffer());
  if (heightsBytes.byteLength !== site.heights.bytes) {
    throw new DetailManifestError(
      `${heightsUrl} is ${heightsBytes.byteLength} B, ` +
        `manifest recorded ${site.heights.bytes} B`,
    );
  }
  const satelliteBytes = new Uint8Array(await satRes.arrayBuffer());
  if (satelliteBytes.byteLength !== site.satellite.bytes) {
    throw new DetailManifestError(
      `${satUrl} is ${satelliteBytes.byteLength} B, ` +
        `manifest recorded ${site.satellite.bytes} B`,
    );
  }
  return {
    heightfield: new Heightfield(
      decodeHeightsLE(heightsBytes),
      site.heights.grid,
    ),
    satelliteBytes,
  };
}

/** Decoded satellite image size must match the manifest grid exactly. */
export function assertDetailSatelliteSize(
  site: DetailSite,
  width: number,
  height: number,
): void {
  if (
    width !== site.satellite.grid.width ||
    height !== site.satellite.grid.height
  ) {
    throw new DetailManifestError(
      `${site.satellite.file} decoded as ${width}x${height}, expected ` +
        `${site.satellite.grid.width}x${site.satellite.grid.height}`,
    );
  }
}
