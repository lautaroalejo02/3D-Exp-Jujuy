/**
 * Detail-patch pipeline: data/raw/detail -> data/build/detail.
 *
 * For each site declared in data/raw/detail/sources.json,
 * data/raw/detail/sources-2.json (the second batch adds san-salvador,
 * humahuaca and tilcara) and data/raw/detail/sources-3.json (the third
 * batch adds the 23 remaining marked places — same layers and zooms):
 *
 * - mosaics the Sentinel-2 cloudless 2016 tiles (EOX, layer
 *   s2cloudless_3857, z14 ~9 m/px — Sentinel-2's 10 m native resolution is
 *   the ceiling of the free source; higher zooms would only interpolate),
 *   decoding with jpeg-js and re-encoding as ONE JPEG at quality 85;
 * - decodes the Terrarium DEM tiles (z12 ~35 m/px, matching SRTM's native
 *   resolution) with pngjs and reuses the pure raster helpers
 *   (decodeTerrarium, cropGrid) — the same offline decoding rule as
 *   build-data: no browser canvas, so color management cannot alter the
 *   elevation bytes;
 * - crops the DEM mosaic to the satellite extent in global pixel space
 *   (src/terrain/detail-grids.ts) after asserting the z12 block fully
 *   covers the z14 window;
 * - writes heights as Int16 little-endian meters and a manifest
 *   (detail/manifest.json) with grid specs, file sizes + sha256,
 *   elevation stats and the patch ground size.
 *
 * Every raw tile's sha256 is verified against its declaring source file
 * BEFORE it is decoded — a mismatch fails the build loudly. All three
 * source manifests are hashed into the manifest (inputSha256) so the
 * cache invalidates if any declared tile, url or site changes.
 *
 * Re-runnable and deterministic: no timestamps, stable encoders, stable
 * key order in JSON.stringify. When detail/manifest.json already records
 * the current input hash, the current PIPELINE_VERSION, every
 * manifest-listed output exists with the recorded size and sha256, AND
 * every raw tile on disk still matches its declared sha256 (the
 * inputSha256 alone cannot catch a tile corrupted in place), prints
 * "up to date" and does nothing. `--force` rebuilds.
 *
 * data/raw/ is only read here, never written ("data/raw/ no se
 * modifica", AGENTS.md). `npm run verify:detail` re-downloads the tile
 * URLs and compares hashes without touching disk.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { decode as decodeJpeg, encode as encodeJpeg } from "jpeg-js";
import { PNG } from "pngjs";

import {
  detailSiteGrids,
  detailSiteSizeKm,
  type DetailSiteGrids,
  type DetailTileRange,
} from "../src/terrain/detail-grids";
import { DETAIL_SCHEMA_VERSION, type DetailSite } from "../src/terrain/detail-manifest";
import { encodeHeightsLE, HEIGHTS_ENCODING } from "../src/terrain/encoding";
import { cropGrid, decodeTerrarium } from "../src/terrain/raster";
import { elevationStats } from "../src/terrain/stats";
import { assertSameGroundExtent } from "../src/terrain/validate";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
/**
 * Every raw source manifest the pipeline reads, in build order. The
 * second batch (sources-2.json) declares san-salvador, humahuaca and
 * tilcara; the third (sources-3.json) the 23 remaining marked places —
 * all three files' bytes feed the manifest's inputSha256.
 */
const SOURCES_PATHS = [
  join(ROOT, "data/raw/detail/sources.json"),
  join(ROOT, "data/raw/detail/sources-2.json"),
  join(ROOT, "data/raw/detail/sources-3.json"),
];
const OUT_DIR = join(ROOT, "data/build/detail");
const MANIFEST_PATH = join(OUT_DIR, "manifest.json");
const TILE_SIZE_PX = 256;
const JPEG_QUALITY = 85;

/**
 * Output format version, written to manifest.json and part of the cache
 * key. Bump whenever decoding, cropping, mosaicking, encoding or the
 * input manifest set changes.
 */
const PIPELINE_VERSION = 3;

interface SourcesSite {
  readonly id: string;
  readonly name: string;
  readonly wikidata: string;
  readonly lat: number;
  readonly lon: number;
  readonly satellite: DetailTileRange & {
    readonly layer: string;
    readonly template: string;
  };
  readonly dem: DetailTileRange & { readonly template: string };
  readonly source: {
    readonly kind: string;
    readonly url: string;
    // The Wikidata/OSM property the coordinate came from; sources-3
    // sites resolve through places.json instead, so it may be absent.
    readonly property?: string;
  };
}

interface SourcesTile {
  readonly file: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface SourcesDoc {
  readonly description: string;
  readonly sites: readonly SourcesSite[];
  readonly tiles: readonly SourcesTile[];
}

interface CacheFileState {
  readonly bytes: number;
  readonly sha256: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

function fileEntry(rel: string): {
  file: string;
  bytes: number;
  sha256: string;
} {
  const bytes = readFileSync(join(OUT_DIR, rel));
  return { file: rel, bytes: bytes.length, sha256: sha256(bytes) };
}

/**
 * Cache check for the detail build: up to date when the previous manifest
 * records the same pipeline version and input hash AND every output it
 * lists exists with the recorded byte size and sha256. Returns the failed
 * check as a reason string, or undefined when fresh.
 */
function checkPreviousBuild(
  inputSha256: string,
  fileState: (file: string) => CacheFileState | undefined,
): string | undefined {
  if (!existsSync(MANIFEST_PATH)) return "detail/manifest.json is missing";
  let previous: unknown;
  try {
    previous = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    return "detail/manifest.json is unreadable";
  }
  const m = previous as {
    pipelineVersion?: unknown;
    inputSha256?: unknown;
    sites?: { heights?: { file?: unknown }; satellite?: { file?: unknown } }[];
  } | null;
  if (m?.pipelineVersion !== PIPELINE_VERSION) {
    return `pipeline version changed (manifest recorded ${String(m?.pipelineVersion)}, pipeline is ${PIPELINE_VERSION})`;
  }
  if (m.inputSha256 !== inputSha256) {
    return "input sources hash changed";
  }
  if (!Array.isArray(m.sites)) {
    return "detail/manifest.json lists no sites";
  }
  const files: unknown[] = m.sites.flatMap((s) => [
    s.heights?.file,
    s.satellite?.file,
  ]);
  for (const file of files) {
    if (typeof file !== "string") {
      return "detail/manifest.json does not list every build output";
    }
    const actual = fileState(file);
    if (!actual) return `missing output ${file}`;
    const recorded = readRecordedEntry(m, file);
    if (recorded === undefined) {
      return `detail/manifest.json lacks size+sha256 for ${file}`;
    }
    if (actual.bytes !== recorded.bytes) {
      return `${file} is ${actual.bytes} B on disk, manifest recorded ${recorded.bytes} B`;
    }
    if (actual.sha256 !== recorded.sha256) {
      return `${file} sha256 does not match the manifest`;
    }
  }
  return undefined;
}

/** Find the recorded {bytes, sha256} for an output file in the manifest. */
function readRecordedEntry(
  manifest: unknown,
  file: string,
): { bytes: number; sha256: string } | undefined {
  const sites = (manifest as { sites?: unknown })?.sites;
  if (!Array.isArray(sites)) return undefined;
  for (const site of sites) {
    for (const key of ["heights", "satellite"] as const) {
      const entry = (site as Record<string, unknown>)[key];
      if (
        typeof entry === "object" &&
        entry !== null &&
        (entry as { file?: unknown }).file === file
      ) {
        const e = entry as { bytes?: unknown; sha256?: unknown };
        if (typeof e.bytes === "number" && typeof e.sha256 === "string") {
          return { bytes: e.bytes, sha256: e.sha256 };
        }
      }
    }
  }
  return undefined;
}

/**
 * Raw-tile freshness for the cache: inputSha256 only proves the source manifests
 * are unchanged — a tile corrupted or replaced on disk under an untouched
 * manifest would otherwise be declared "up to date". Every declared tile
 * is re-hashed here before the cache verdict; a mismatch just rebuilds
 * (the build itself will then fail loudly inside readVerifiedTile).
 */
function checkRawTiles(tiles: readonly SourcesTile[]): string | undefined {
  for (const tile of tiles) {
    const path = join(ROOT, tile.file);
    if (!existsSync(path)) return `raw tile ${tile.file} is missing`;
    const bytes = readFileSync(path);
    if (bytes.length !== tile.bytes) {
      return (
        `raw tile ${tile.file} is ${bytes.length} B, ` +
        `the sources manifest recorded ${tile.bytes} B`
      );
    }
    if (sha256(bytes) !== tile.sha256) {
      return `raw tile ${tile.file} sha256 does not match the sources manifest`;
    }
  }
  return undefined;
}

/** Read + verify a raw tile against its sources-manifest record, then decode. */
function readVerifiedTile(
  record: SourcesTile,
): Uint8Array {
  const path = join(ROOT, record.file);
  if (!existsSync(path)) {
    throw new Error(`${record.file} is missing (declared in a sources manifest)`);
  }
  const bytes = readFileSync(path);
  if (bytes.length !== record.bytes) {
    throw new Error(
      `${record.file} is ${bytes.length} B, the sources manifest recorded ${record.bytes} B`,
    );
  }
  const actual = sha256(bytes);
  if (actual !== record.sha256) {
    throw new Error(
      `${record.file} sha256 mismatch: the sources manifest recorded ` +
        `${record.sha256}, file on disk hashes to ${actual}; ` +
        `run "npm run verify:detail" to check the tile against its URL`,
    );
  }
  return bytes;
}

/** Expected tile file name for a site/kind/z/x/y — mirrors the download. */
function tileFileName(
  siteId: string,
  kind: "satellite" | "dem",
  zoom: number,
  x: number,
  y: number,
): string {
  const ext = kind === "satellite" ? "jpg" : "png";
  return `data/raw/detail/${siteId}/${kind}/${zoom}_${x}_${y}.${ext}`;
}

function requireTileRecord(
  tiles: Map<string, SourcesTile>,
  file: string,
): SourcesTile {
  const record = tiles.get(file);
  if (!record) {
    throw new Error(
      `${file} is expected by the site's tile ranges but missing from ` +
        `the sources manifest`,
    );
  }
  return record;
}

/** Decode + verify all satellite tiles of a site into one RGBA mosaic. */
function mosaicSatellite(
  site: SourcesSite,
  grids: DetailSiteGrids,
  tiles: Map<string, SourcesTile>,
): Uint8Array {
  const { satelliteGrid, satelliteTilesX, satelliteTilesY } = grids;
  const mosaic = new Uint8Array(
    satelliteGrid.width * satelliteGrid.height * 4,
  );
  for (let ty = 0; ty < satelliteTilesY; ty++) {
    for (let tx = 0; tx < satelliteTilesX; tx++) {
      const x = site.satellite.x[0] + tx;
      const y = site.satellite.y[0] + ty;
      const file = tileFileName(site.id, "satellite", site.satellite.zoom, x, y);
      const bytes = readVerifiedTile(requireTileRecord(tiles, file));
      const tile = decodeJpeg(bytes, {
        formatAsRGBA: true,
        useTArray: true,
        maxMemoryUsageInMB: 256,
      });
      if (tile.width !== TILE_SIZE_PX || tile.height !== TILE_SIZE_PX) {
        throw new Error(
          `${file} decoded as ${tile.width}x${tile.height}, expected ` +
            `${TILE_SIZE_PX}x${TILE_SIZE_PX}`,
        );
      }
      for (let row = 0; row < TILE_SIZE_PX; row++) {
        const dst = ((ty * TILE_SIZE_PX + row) * satelliteGrid.width + tx * TILE_SIZE_PX) * 4;
        const src = row * TILE_SIZE_PX * 4;
        mosaic.set(tile.data.subarray(src, src + TILE_SIZE_PX * 4), dst);
      }
    }
  }
  return mosaic;
}

/** Decode + verify all DEM tiles of a site into one float height mosaic. */
function mosaicDem(
  site: SourcesSite,
  grids: DetailSiteGrids,
  tiles: Map<string, SourcesTile>,
): Float32Array {
  const { demMosaicGrid, demTilesX, demTilesY } = grids;
  const mosaic = new Float32Array(
    demMosaicGrid.width * demMosaicGrid.height,
  );
  for (let ty = 0; ty < demTilesY; ty++) {
    for (let tx = 0; tx < demTilesX; tx++) {
      const x = site.dem.x[0] + tx;
      const y = site.dem.y[0] + ty;
      const file = tileFileName(site.id, "dem", site.dem.zoom, x, y);
      const bytes = readVerifiedTile(requireTileRecord(tiles, file));
      const png = PNG.sync.read(Buffer.from(bytes));
      if (png.width !== TILE_SIZE_PX || png.height !== TILE_SIZE_PX) {
        throw new Error(
          `${file} decoded as ${png.width}x${png.height}, expected ` +
            `${TILE_SIZE_PX}x${TILE_SIZE_PX}`,
        );
      }
      const heights = decodeTerrarium(png.data, png.width, png.height);
      for (let row = 0; row < TILE_SIZE_PX; row++) {
        const dst =
          (ty * TILE_SIZE_PX + row) * demMosaicGrid.width +
          tx * TILE_SIZE_PX;
        const src = row * TILE_SIZE_PX;
        mosaic.set(
          heights.subarray(src, src + TILE_SIZE_PX),
          dst,
        );
      }
    }
  }
  return mosaic;
}

function buildSite(
  site: SourcesSite,
  tiles: Map<string, SourcesTile>,
): { site: DetailSite; outputs: readonly string[] } {
  const grids = detailSiteGrids(site.id, site.satellite, site.dem);
  assertSameGroundExtent(grids.heightsGrid, grids.satelliteGrid);

  const satelliteRgba = mosaicSatellite(site, grids, tiles);
  const satelliteJpg = encodeJpeg(
    {
      data: satelliteRgba,
      width: grids.satelliteGrid.width,
      height: grids.satelliteGrid.height,
    },
    JPEG_QUALITY,
  );
  writeFileSync(
    join(OUT_DIR, site.id, "satellite.jpg"),
    satelliteJpg.data,
  );

  const demMosaic = mosaicDem(site, grids, tiles);
  const heights = cropGrid(
    demMosaic,
    grids.demMosaicGrid.width,
    grids.demMosaicGrid.height,
    grids.demCrop.x,
    grids.demCrop.y,
    grids.demCrop.width,
    grids.demCrop.height,
  );
  writeFileSync(
    join(OUT_DIR, site.id, "heights.bin"),
    encodeHeightsLE(heights),
  );

  const manifestSite: DetailSite = {
    id: site.id,
    name: site.name,
    wikidata: site.wikidata,
    lon: site.lon,
    lat: site.lat,
    source: {
      kind: site.source.kind,
      url: site.source.url,
      property: site.source.property,
    },
    heights: {
      ...fileEntry(`${site.id}/heights.bin`),
      grid: grids.heightsGrid,
      encoding: HEIGHTS_ENCODING,
      elevation: elevationStats(heights),
    },
    satellite: {
      ...fileEntry(`${site.id}/satellite.jpg`),
      grid: grids.satelliteGrid,
    },
    sizeKm: detailSiteSizeKm(grids.heightsGrid),
  };
  console.log(
    `  ${site.id}: satellite ${grids.satelliteGrid.width}x` +
      `${grids.satelliteGrid.height}, heights ${grids.heightsGrid.width}x` +
      `${grids.heightsGrid.height} (crop at ${grids.demCrop.x},` +
      `${grids.demCrop.y} of ${grids.demMosaicGrid.width}x` +
      `${grids.demMosaicGrid.height}), min ` +
      `${manifestSite.heights.elevation.minMeters} m / max ` +
      `${manifestSite.heights.elevation.maxMeters} m`,
  );
  return {
    site: manifestSite,
    outputs: [
      `${site.id}/satellite.jpg`,
      `${site.id}/heights.bin`,
    ],
  };
}

function main(): void {
  const force = process.argv.includes("--force");

  // Both source manifests feed one combined input hash and one merged
  // site/tile list; a site id or tile file declared twice is a data bug
  // and fails loudly rather than silently overriding.
  const inputHash = createHash("sha256");
  const sites: SourcesSite[] = [];
  const tiles = new Map<string, SourcesTile>();
  const siteIds = new Set<string>();
  for (const sourcesPath of SOURCES_PATHS) {
    const sourcesBytes = readFileSync(sourcesPath);
    inputHash.update(sourcesBytes);
    const manifest = JSON.parse(sourcesBytes.toString("utf8")) as SourcesDoc;
    const manifestName = sourcesPath.split(/[\\/]/).pop() ?? sourcesPath;
    for (const site of manifest.sites) {
      if (siteIds.has(site.id)) {
        throw new Error(
          `site id "${site.id}" is declared in two source manifests ` +
            `(${manifestName})`,
        );
      }
      siteIds.add(site.id);
      sites.push(site);
    }
    for (const tile of manifest.tiles) {
      if (tiles.has(tile.file)) {
        throw new Error(
          `tile "${tile.file}" is declared in two source manifests ` +
            `(${manifestName})`,
        );
      }
      tiles.set(tile.file, tile);
    }
  }
  const inputSha256 = inputHash.digest("hex");

  if (!force) {
    const fileState = (file: string): CacheFileState | undefined => {
      const path = join(OUT_DIR, file);
      if (!existsSync(path)) return undefined;
      const bytes = readFileSync(path);
      return { bytes: bytes.length, sha256: sha256(bytes) };
    };
    const reason =
      checkPreviousBuild(inputSha256, fileState) ??
      checkRawTiles([...tiles.values()]);
    if (reason === undefined) {
      console.log("up to date");
      return;
    }
    console.log(`${reason}; rebuilding`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const builtSites: DetailSite[] = [];
  for (const site of sites) {
    mkdirSync(join(OUT_DIR, site.id), { recursive: true });
    builtSites.push(buildSite(site, tiles).site);
  }

  // Coverage check: every tile recorded in a sources manifest should
  // belong to one of the declared sites — warn (not fail) on leftovers
  // so an intentional extra download does not break the build.
  const expected = new Set<string>();
  for (const site of sites) {
    const grids = detailSiteGrids(site.id, site.satellite, site.dem);
    for (let ty = 0; ty < grids.satelliteTilesY; ty++) {
      for (let tx = 0; tx < grids.satelliteTilesX; tx++) {
        expected.add(
          tileFileName(
            site.id,
            "satellite",
            site.satellite.zoom,
            site.satellite.x[0] + tx,
            site.satellite.y[0] + ty,
          ),
        );
      }
    }
    for (let ty = 0; ty < grids.demTilesY; ty++) {
      for (let tx = 0; tx < grids.demTilesX; tx++) {
        expected.add(
          tileFileName(
            site.id,
            "dem",
            site.dem.zoom,
            site.dem.x[0] + tx,
            site.dem.y[0] + ty,
          ),
        );
      }
    }
  }
  for (const file of tiles.keys()) {
    if (!expected.has(file)) {
      console.warn(
        `warning: ${file} is recorded in a sources manifest but not ` +
          `covered by any site's tile ranges`,
      );
    }
  }

  const manifest = {
    schemaVersion: DETAIL_SCHEMA_VERSION,
    pipelineVersion: PIPELINE_VERSION,
    inputSha256,
    sites: builtSites,
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");

  console.log("data/build/detail written:");
  for (const site of builtSites) {
    for (const entry of [site.satellite, site.heights]) {
      console.log(
        `  ${entry.file}: ${fmtBytes(statSync(join(OUT_DIR, entry.file)).size)}`,
      );
    }
  }
  console.log("  manifest.json");
}

main();
