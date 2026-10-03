/**
 * Data pipeline: data/raw -> data/build.
 *
 * - Decodes the Terrarium DEM PNG (2560x2560) with pngjs, crops it to the
 *   DEM_GRID window and writes Int16-LE heights at full and half resolution.
 * - Copies the raw Sentinel-2 JPEG as-is and writes a 2x2 box-downsampled
 *   re-encode at quality 85 for the default quality level.
 * - Emits terrain.json (manifest), and debug-alignment.png (hillshade over
 *   satellite, for humans to check DEM/imagery registration; not shipped).
 *
 * Re-runnable and deterministic: no timestamps, stable encoders. When
 * data/build/terrain.json already records the current input hashes, the
 * current PIPELINE_VERSION, and every manifest-listed output exists with
 * the recorded size and sha256, prints "up to date" and does nothing.
 * `--force` rebuilds.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decode as decodeJpeg, encode as encodeJpeg } from "jpeg-js";
import { PNG } from "pngjs";

import { downsampleGrid, type GridSpec } from "../src/geo/grid";
import { DEM_GRID, DEM_MOSAIC_GRID, SATELLITE_GRID } from "../src/geo/jujuy";
import { metersPerGridCell } from "../src/geo/world";
import {
  checkBuildCache,
  type BuildCacheVerdict,
  type CacheFileState,
} from "../src/terrain/build-cache";
import {
  decodeHeightsLE,
  encodeHeightsLE,
  HEIGHTS_ENCODING,
} from "../src/terrain/encoding";
import {
  TERRAIN_SCHEMA_VERSION,
  type ElevationStats,
  type ReconstructionError,
  type TerrainManifest,
} from "../src/terrain/manifest";
import {
  boxDownsample,
  boxDownsampleRgba,
  cropGrid,
  decodeTerrarium,
  hillshade,
} from "../src/terrain/raster";
import { elevationStats, reconstructionError } from "../src/terrain/stats";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEM_PATH = join(
  ROOT,
  "data/raw/jujuy_terrarium_z10_x320-329_y575-584.png",
);
const SAT_PATH = join(
  ROOT,
  "data/raw/jujuy_s2cloudless2016_z11_x641-659_y1150-1169.jpg",
);
const OUT_DIR = join(ROOT, "data/build");

/**
 * Output format version, written to terrain.json and part of the cache
 * key. Bump whenever decoding, cropping, downsampling or encoding changes
 * so outputs produced by an older pipeline are rebuilt instead of kept.
 */
const PIPELINE_VERSION = 2;

const OUTPUT_FILES = [
  "heights-full.bin",
  "heights-half.bin",
  "satellite-full.jpg",
  "satellite-half.jpg",
  "terrain.json",
  "debug-alignment.png",
] as const;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

function fileEntry(name: string): {
  file: string;
  bytes: number;
  sha256: string;
} {
  const bytes = readFileSync(join(OUT_DIR, name));
  return { file: name, bytes: bytes.length, sha256: sha256(bytes) };
}

function readPreviousManifest(): unknown {
  const manifestPath = join(OUT_DIR, "terrain.json");
  if (!existsSync(manifestPath)) return undefined;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function checkPreviousBuild(demSha: string, satSha: string): BuildCacheVerdict {
  const fileState = (name: string): CacheFileState | undefined => {
    const path = join(OUT_DIR, name);
    if (!existsSync(path)) return undefined;
    const bytes = readFileSync(path);
    return { bytes: bytes.length, sha256: sha256(bytes) };
  };
  return checkBuildCache(
    readPreviousManifest(),
    {
      pipelineVersion: PIPELINE_VERSION,
      demSha256: demSha,
      satelliteSha256: satSha,
    },
    fileState,
  );
}

function main(): void {
  const force = process.argv.includes("--force");
  const demBytes = readFileSync(DEM_PATH);
  const satBytes = readFileSync(SAT_PATH);
  const demSha = sha256(demBytes);
  const satSha = sha256(satBytes);

  if (!force) {
    const verdict = checkPreviousBuild(demSha, satSha);
    if (verdict.upToDate) {
      console.log("up to date");
      return;
    }
    console.log(`${verdict.reason}; rebuilding`);
  }

  mkdirSync(OUT_DIR, { recursive: true });

  // --- DEM ---
  const demPng = PNG.sync.read(demBytes);
  if (
    demPng.width !== DEM_MOSAIC_GRID.width ||
    demPng.height !== DEM_MOSAIC_GRID.height
  ) {
    throw new Error(
      `DEM mosaic is ${demPng.width}x${demPng.height}, expected ` +
        `${DEM_MOSAIC_GRID.width}x${DEM_MOSAIC_GRID.height}`,
    );
  }
  const mosaic = decodeTerrarium(demPng.data, demPng.width, demPng.height);
  const cropX = DEM_GRID.originPx[0] - DEM_MOSAIC_GRID.originPx[0];
  const cropY = DEM_GRID.originPx[1] - DEM_MOSAIC_GRID.originPx[1];
  const heightsFull = cropGrid(
    mosaic,
    demPng.width,
    demPng.height,
    cropX,
    cropY,
    DEM_GRID.width,
    DEM_GRID.height,
  );
  const heightsFullBin = encodeHeightsLE(heightsFull);
  writeFileSync(join(OUT_DIR, "heights-full.bin"), heightsFullBin);

  const halfSpec = downsampleGrid(DEM_GRID, 2);
  const half = boxDownsample(
    heightsFull,
    DEM_GRID.width,
    DEM_GRID.height,
    2,
  );
  if (half.width !== halfSpec.width || half.height !== halfSpec.height) {
    throw new Error(
      `half-res grid is ${half.width}x${half.height}, expected ${halfSpec.width}x${halfSpec.height}`,
    );
  }
  const heightsHalfBin = encodeHeightsLE(half.data);
  writeFileSync(join(OUT_DIR, "heights-half.bin"), heightsHalfBin);

  // --- Satellite ---
  const sat = decodeJpeg(satBytes, {
    formatAsRGBA: true,
    maxMemoryUsageInMB: 1024,
  });
  if (
    sat.width !== SATELLITE_GRID.width ||
    sat.height !== SATELLITE_GRID.height
  ) {
    throw new Error(
      `satellite mosaic is ${sat.width}x${sat.height}, expected ` +
        `${SATELLITE_GRID.width}x${SATELLITE_GRID.height}`,
    );
  }
  copyFileSync(SAT_PATH, join(OUT_DIR, "satellite-full.jpg"));
  const satHalfSpec = downsampleGrid(SATELLITE_GRID, 2);
  const satHalf = boxDownsampleRgba(sat.data, sat.width, sat.height, 2);
  if (
    satHalf.width !== satHalfSpec.width ||
    satHalf.height !== satHalfSpec.height
  ) {
    throw new Error(
      `half-res satellite is ${satHalf.width}x${satHalf.height}, expected ${satHalfSpec.width}x${satHalfSpec.height}`,
    );
  }
  const satHalfJpg = encodeJpeg(
    { data: satHalf.data, width: satHalf.width, height: satHalf.height },
    85,
  );
  writeFileSync(join(OUT_DIR, "satellite-half.jpg"), satHalfJpg.data);

  // --- Reconstruction error of the default level: for every full-res cell,
  // |stored full height - bilinear sample of the stored half-res grid| at the
  // cell's center. This is the error the "default" quality actually shows.
  const reconError = reconstructionError(
    decodeHeightsLE(heightsFullBin),
    DEM_GRID.width,
    DEM_GRID.height,
    decodeHeightsLE(heightsHalfBin),
    halfSpec.width,
    halfSpec.height,
    halfSpec.scale / DEM_GRID.scale,
  );

  // --- Debug overlay: hillshade from the full-res heights blended 50% over
  // the half-res satellite image so ridges can be checked against imagery.
  const shade = hillshade(
    heightsFull,
    DEM_GRID.width,
    DEM_GRID.height,
    metersPerGridCell(DEM_GRID),
  );
  const blended = new Uint8Array(satHalf.width * satHalf.height * 4);
  for (let p = 0, k = 0; k < shade.length; p += 4, k++) {
    blended[p] = Math.round(0.5 * (satHalf.data[p] ?? 0) + 0.5 * (shade[k] ?? 0));
    blended[p + 1] = Math.round(
      0.5 * (satHalf.data[p + 1] ?? 0) + 0.5 * (shade[k] ?? 0),
    );
    blended[p + 2] = Math.round(
      0.5 * (satHalf.data[p + 2] ?? 0) + 0.5 * (shade[k] ?? 0),
    );
    blended[p + 3] = 255;
  }
  const debugPng = new PNG({ width: satHalf.width, height: satHalf.height });
  debugPng.data = Buffer.from(blended);
  writeFileSync(join(OUT_DIR, "debug-alignment.png"), PNG.sync.write(debugPng));

  // --- Manifest ---
  const heightsEntry = (
    name: string,
    grid: GridSpec,
    elevation: ElevationStats,
    reconstruction?: ReconstructionError,
  ): TerrainManifest["levels"]["default"]["heights"] => ({
    ...fileEntry(name),
    grid,
    encoding: HEIGHTS_ENCODING,
    elevation,
    ...(reconstruction ? { reconstructionError: reconstruction } : {}),
  });
  const satEntry = (
    name: string,
    grid: GridSpec,
  ): TerrainManifest["levels"]["default"]["satellite"] => ({
    ...fileEntry(name),
    grid,
  });

  const manifest: TerrainManifest = {
    schemaVersion: TERRAIN_SCHEMA_VERSION,
    pipelineVersion: PIPELINE_VERSION,
    levels: {
      default: {
        heights: heightsEntry(
          "heights-half.bin",
          halfSpec,
          elevationStats(half.data),
          reconError,
        ),
        satellite: satEntry("satellite-half.jpg", satHalfSpec),
      },
      high: {
        heights: heightsEntry(
          "heights-full.bin",
          DEM_GRID,
          elevationStats(heightsFull),
        ),
        satellite: satEntry("satellite-full.jpg", SATELLITE_GRID),
      },
    },
    sources: {
      dem: {
        file: basename(DEM_PATH),
        path: "data/raw/" + basename(DEM_PATH),
        bytes: statSync(DEM_PATH).size,
        sha256: demSha,
      },
      satellite: {
        file: basename(SAT_PATH),
        path: "data/raw/" + basename(SAT_PATH),
        bytes: statSync(SAT_PATH).size,
        sha256: satSha,
      },
      attribution:
        "See ATTRIBUTIONS.md — DEM: Terrain Tiles (Mapzen / AWS Open Data, " +
        "Terrarium format; SRTM/GMTED2010/ETOPO1, public domain). " +
        "Imagery: Sentinel-2 cloudless 2016 by EOX IT Services GmbH, CC BY 4.0.",
    },
  };
  writeFileSync(
    join(OUT_DIR, "terrain.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );

  // --- Summary ---
  const full = manifest.levels.high;
  const def = manifest.levels.default;
  console.log("data/build written:");
  for (const name of OUTPUT_FILES) {
    console.log(`  ${name}: ${fmtBytes(statSync(join(OUT_DIR, name)).size)}`);
  }
  const elev = (e: ElevationStats): string =>
    `min ${e.minMeters} m  max ${e.maxMeters} m  mean ${e.meanMeters} m  ` +
    `p0.1% ${e.p001Meters} m  p99.9% ${e.p999Meters} m`;
  console.log(
    `heights full  ${DEM_GRID.width}x${DEM_GRID.height}  ${elev(full.heights.elevation)}`,
  );
  console.log(
    `heights half  ${halfSpec.width}x${halfSpec.height}  ${elev(def.heights.elevation)}`,
  );
  console.log(
    `satellite full ${SATELLITE_GRID.width}x${SATELLITE_GRID.height}, ` +
      `half ${satHalfSpec.width}x${satHalfSpec.height} (jpeg q85)`,
  );
  console.log(
    `half-res reconstruction error vs full-res: max ${reconError.maxAbsErrorMeters} m, ` +
      `mean ${reconError.meanAbsErrorMeters} m, p99 ${reconError.p99AbsErrorMeters} m, ` +
      `${(reconError.fractionOver20Meters * 100).toFixed(2)}% of cells over 20 m`,
  );
}

main();
