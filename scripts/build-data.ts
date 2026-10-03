/**
 * Data pipeline: data/raw -> data/build.
 *
 * - Decodes the Terrarium DEM PNG (2560x2560) with pngjs, crops it to the
 *   DEM_GRID window and writes Int16-LE heights at full and half resolution.
 * - Copies the raw Sentinel-2 JPEG as-is and writes a 2x2 box-downsampled
 *   re-encode at quality 85 for the default quality level.
 * - Rasterizes the 16 Jujuy departments (data/raw/…-jujuy.geojson, the
 *   committed extract checked by `npm run verify:boundaries`) into a
 *   Uint8 index per level,
 *   computes the province signed distance field (Int8, cells) per level,
 *   writes departments.json and the province bounding boxes.
 * - Emits terrain.json (manifest), debug-alignment.png (hillshade over
 *   satellite, for humans to check DEM/imagery registration; not shipped)
 *   and debug-province.png (boundary outlines over satellite; not
 *   shipped).
 *
 * Re-runnable and deterministic: no timestamps, stable encoders. When
 * data/build/terrain.json already records the current input hashes, the
 * current PIPELINE_VERSION, and every manifest-listed output exists with
 * the recorded size and sha256, prints "up to date" and does nothing.
 * `--force` rebuilds.
 *
 * data/raw/ is only read here, never written ("data/raw/ no se
 * modifica", AGENTS.md). The boundaries extract inside it is committed
 * as a fixed raw input; `npm run verify:boundaries` re-checks it against
 * the pinned upstream file.
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
  DEPARTMENT_INDEX_ENCODING,
  PROVINCE_OUTLINE_ENCODING,
  PROVINCE_SDF_ENCODING,
  TERRAIN_SCHEMA_VERSION,
  type ElevationStats,
  type ReconstructionError,
  type TerrainManifest,
} from "../src/terrain/manifest";
import { provinceOutlineRing } from "../src/terrain/outline";
import {
  boxDownsample,
  boxDownsampleRgba,
  cropGrid,
  decodeTerrarium,
  hillshade,
} from "../src/terrain/raster";
import {
  geometryToPolygons,
  JUJUY_DEPARTMENT_NAMES,
  majorityDownsampleIndex,
  normalizeDepartmentName,
  nonzeroCellBounds,
  rasterizeDepartments,
  unionBBox,
  type GeoJsonFeature,
} from "../src/terrain/raster-vector";
import { signedDistanceField } from "../src/terrain/sdf";
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
const BOUNDS_PATH = join(
  ROOT,
  "data/raw/geoBoundaries-ARG-ADM2-jujuy.geojson",
);
const OUT_DIR = join(ROOT, "data/build");

/**
 * Output format version, written to terrain.json and part of the cache
 * key. Bump whenever decoding, cropping, downsampling or encoding changes
 * so outputs produced by an older pipeline are rebuilt instead of kept.
 *
 * v3: added department index rasters, province SDFs, departments.json and
 * the province bounding boxes.
 * v4: added the province outline rings (province-outline-*.bin) the
 * diorama's cut wall follows.
 */
const PIPELINE_VERSION = 4;

/**
 * Douglas-Peucker tolerance for the province outline ring, in the level's
 * grid cells (~0.5 km/cell at full res): collapses marching-squares
 * stair-steps while keeping the boundary within ~1 cell of iso 0.
 */
const OUTLINE_TOLERANCE_CELLS = 1.0;

const OUTPUT_FILES = [
  "heights-full.bin",
  "heights-half.bin",
  "satellite-full.jpg",
  "satellite-half.jpg",
  "departments-full.bin",
  "departments-half.bin",
  "province-sdf-full.bin",
  "province-sdf-half.bin",
  "province-outline-full.bin",
  "province-outline-half.bin",
  "departments.json",
  "terrain.json",
  "debug-alignment.png",
  "debug-province.png",
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

function checkPreviousBuild(
  demSha: string,
  satSha: string,
  boundsSha: string,
): BuildCacheVerdict {
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
      boundariesSha256: boundsSha,
    },
    fileState,
  );
}

function readBoundsBytes(): Buffer {
  try {
    return readFileSync(BOUNDS_PATH);
  } catch (cause) {
    throw new Error(
      `${BOUNDS_PATH} is missing or unreadable; restore the committed ` +
        `extract (verify it with "npm run verify:boundaries")`,
      { cause },
    );
  }
}

function main(): void {
  const force = process.argv.includes("--force");
  const demBytes = readFileSync(DEM_PATH);
  const satBytes = readFileSync(SAT_PATH);
  const boundsBytes = readBoundsBytes();
  const demSha = sha256(demBytes);
  const satSha = sha256(satBytes);
  const boundsSha = sha256(boundsBytes);

  if (!force) {
    const verdict = checkPreviousBuild(demSha, satSha, boundsSha);
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

  // --- Boundaries: department index rasters, province SDFs, metadata ---
  const bounds = JSON.parse(boundsBytes.toString("utf8")) as {
    type?: unknown;
    features?: GeoJsonFeature[];
  };
  if (bounds.type !== "FeatureCollection" || !Array.isArray(bounds.features)) {
    throw new Error(`${BOUNDS_PATH} is not a GeoJSON FeatureCollection`);
  }
  if (bounds.features.length !== JUJUY_DEPARTMENT_NAMES.length) {
    throw new Error(
      `${BOUNDS_PATH} has ${bounds.features.length} features, expected ` +
        `${JUJUY_DEPARTMENT_NAMES.length} Jujuy departments; ` +
        `run "npm run verify:boundaries" to check the committed extract`,
    );
  }
  // JUJUY_DEPARTMENT_NAMES is a checklist, not data: assert every
  // expected department is present exactly once (normalized comparison)
  // and publish each feature's shapeName verbatim as the name.
  const expectedKeys = new Set(
    JUJUY_DEPARTMENT_NAMES.map(normalizeDepartmentName),
  );
  const seenKeys = new Set<string>();
  const departments = bounds.features.map((f, k) => {
    const sourceName = f.properties?.shapeName;
    if (typeof sourceName !== "string") {
      throw new Error(`boundaries feature ${k} has no shapeName`);
    }
    const nameKey = normalizeDepartmentName(sourceName);
    if (!expectedKeys.has(nameKey)) {
      throw new Error(
        `boundaries feature "${sourceName}" is not a Jujuy department; ` +
          `run "npm run verify:boundaries" to check the committed extract`,
      );
    }
    if (seenKeys.has(nameKey)) {
      throw new Error(
        `boundaries has two features named "${sourceName}"; ` +
          `run "npm run verify:boundaries" to check the committed extract`,
      );
    }
    seenKeys.add(nameKey);
    return {
      name: sourceName,
      nameKey,
      polygons: geometryToPolygons(f.geometry),
    };
  });
  const missing = JUJUY_DEPARTMENT_NAMES.filter(
    (n) => !seenKeys.has(normalizeDepartmentName(n)),
  );
  if (missing.length > 0) {
    throw new Error(
      `${BOUNDS_PATH} is missing departments: ${missing.join(", ")}; ` +
        `run "npm run verify:boundaries" to check the committed extract`,
    );
  }
  // Stable index order: alphabetical by normalized source name — the same
  // order the file's provenance records (see scripts/verify-boundaries.ts).
  departments.sort((a, b) => a.nameKey.localeCompare(b.nameKey));
  const departmentPolygons = departments.map((d) => d.polygons);

  const deptFull = rasterizeDepartments(DEM_GRID, departmentPolygons);
  writeFileSync(join(OUT_DIR, "departments-full.bin"), deptFull);
  const deptHalf = majorityDownsampleIndex(
    deptFull,
    DEM_GRID.width,
    DEM_GRID.height,
    2,
  );
  if (
    deptHalf.width !== halfSpec.width ||
    deptHalf.height !== halfSpec.height
  ) {
    throw new Error(
      `half-res departments grid is ${deptHalf.width}x${deptHalf.height}, ` +
        `expected ${halfSpec.width}x${halfSpec.height}`,
    );
  }
  writeFileSync(join(OUT_DIR, "departments-half.bin"), deptHalf.data);

  // Province signed distance fields, in cells of each level's grid.
  const sdfFull = signedDistanceField(
    Uint8Array.from(deptFull, (v) => (v > 0 ? 1 : 0)),
    DEM_GRID.width,
    DEM_GRID.height,
  );
  writeFileSync(join(OUT_DIR, "province-sdf-full.bin"), sdfFull);
  const sdfHalf = signedDistanceField(
    Uint8Array.from(deptHalf.data, (v) => (v > 0 ? 1 : 0)),
    deptHalf.width,
    deptHalf.height,
  );
  writeFileSync(join(OUT_DIR, "province-sdf-half.bin"), sdfHalf);

  // Province outline rings (the diorama's cut wall, stage Bordes):
  // marching squares over the level's own SDF at iso 0, simplified with
  // Douglas-Peucker — the same mask the shaders sample, so the wall
  // stands exactly on the drawn inside/outside boundary. Float32 pairs
  // in the level grid's coords, closed ring wound positive (the shader
  // derives outward normals from that winding).
  const outlineFull = provinceOutlineRing(
    sdfFull,
    DEM_GRID.width,
    DEM_GRID.height,
    OUTLINE_TOLERANCE_CELLS,
  );
  const outlineHalf = provinceOutlineRing(
    sdfHalf,
    deptHalf.width,
    deptHalf.height,
    OUTLINE_TOLERANCE_CELLS,
  );
  if (!outlineFull || !outlineHalf) {
    throw new Error("province SDF produced no closed outline ring");
  }
  writeFileSync(
    join(OUT_DIR, "province-outline-full.bin"),
    Buffer.from(
      outlineFull.buffer,
      outlineFull.byteOffset,
      outlineFull.byteLength,
    ),
  );
  writeFileSync(
    join(OUT_DIR, "province-outline-half.bin"),
    Buffer.from(
      outlineHalf.buffer,
      outlineHalf.byteOffset,
      outlineHalf.byteLength,
    ),
  );

  const provinceBBoxLonLat = unionBBox(departmentPolygons);
  const provinceBBoxGridFull = nonzeroCellBounds(
    deptFull,
    DEM_GRID.width,
    DEM_GRID.height,
  );
  const provinceBBoxGridHalf = nonzeroCellBounds(
    deptHalf.data,
    deptHalf.width,
    deptHalf.height,
  );
  if (!provinceBBoxGridFull || !provinceBBoxGridHalf) {
    throw new Error("department rasterization produced an empty province mask");
  }

  const departmentsDoc = {
    schemaVersion: 2,
    departments: departments.map((d, i) => ({
      index: i + 1,
      name: d.name,
    })),
    source: {
      name: "geoBoundaries gbOpen, Argentina ADM2",
      // Verbatim from the dataset's metadata — the source string has no
      // accent in "Geografico" (see ATTRIBUTIONS.md).
      provider: "Instituto Geografico Nacional and UNHCR, OCHA ROLAC",
      year: 2020,
      url: "https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/ARG/ADM2/geoBoundaries-ARG-ADM2.geojson",
      metadataUrl:
        "https://www.geoboundaries.org/api/current/gbOpen/ARG/ADM2/",
      releaseCommit: "9469f09",
    },
    license: {
      name: "CC BY 3.0 IGO",
      url: "https://creativecommons.org/licenses/by/3.0/igo/",
    },
    attribution:
      "Límites departamentales de Jujuy: geoBoundaries gbOpen " +
      "(Instituto Geográfico Nacional / UNHCR, OCHA ROLAC), CC BY 3.0 IGO.",
  };
  writeFileSync(
    join(OUT_DIR, "departments.json"),
    JSON.stringify(departmentsDoc, null, 2) + "\n",
  );

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

  // --- Debug overlays. Both paint DEM-grid data onto the half-res
  // satellite image cell-for-cell, which only works when the two grids
  // have identical dimensions; assert instead of silently misaligning.
  if (
    satHalf.width !== DEM_GRID.width ||
    satHalf.height !== DEM_GRID.height
  ) {
    throw new Error(
      `debug overlays require satellite-half (${satHalf.width}x` +
        `${satHalf.height}) to match the DEM grid ` +
        `(${DEM_GRID.width}x${DEM_GRID.height})`,
    );
  }

  // Hillshade from the full-res heights blended 50% over the half-res
  // satellite image so ridges can be checked against imagery.
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

  // --- Debug overlay: province outline (white) and department borders
  // (yellow) over the half-res satellite image. departments-full and
  // satHalf are both 2432x2560 over the same ground extent, so cells
  // align one-to-one. For each edge between differing cells the mark goes
  // on the inside cell (province) or the lower-index cell (departments).
  const PROVINCE_EDGE: readonly [number, number, number] = [255, 255, 255];
  const DEPT_EDGE: readonly [number, number, number] = [255, 210, 0];
  const debugPx = Uint8Array.from(satHalf.data);
  const paint = (k: number, rgb: readonly [number, number, number]): void => {
    debugPx[k * 4] = rgb[0];
    debugPx[k * 4 + 1] = rgb[1];
    debugPx[k * 4 + 2] = rgb[2];
  };
  for (let j = 0; j < DEM_GRID.height; j++) {
    for (let i = 0; i < DEM_GRID.width; i++) {
      const v = deptFull[j * DEM_GRID.width + i] ?? 0;
      const mark = (i2: number, j2: number): void => {
        const v2 = deptFull[j2 * DEM_GRID.width + i2] ?? 0;
        if (v === v2) return;
        if (v === 0 || v2 === 0) {
          paint(v !== 0 ? j * DEM_GRID.width + i : j2 * DEM_GRID.width + i2, PROVINCE_EDGE);
        } else {
          paint(Math.min(v, v2) === v ? j * DEM_GRID.width + i : j2 * DEM_GRID.width + i2, DEPT_EDGE);
        }
      };
      if (i + 1 < DEM_GRID.width) mark(i + 1, j);
      if (j + 1 < DEM_GRID.height) mark(i, j + 1);
    }
  }
  const debugProv = new PNG({
    width: satHalf.width,
    height: satHalf.height,
  });
  debugProv.data = Buffer.from(debugPx);
  writeFileSync(join(OUT_DIR, "debug-province.png"), PNG.sync.write(debugProv));

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
  const deptEntry = (
    name: string,
    sdfName: string,
    outlineName: string,
    outlinePoints: number,
    grid: GridSpec,
    provinceBBoxGrid: readonly [number, number, number, number],
  ): NonNullable<TerrainManifest["levels"]["default"]["departments"]> => ({
    index: {
      ...fileEntry(name),
      grid,
      encoding: DEPARTMENT_INDEX_ENCODING,
    },
    sdf: {
      ...fileEntry(sdfName),
      encoding: PROVINCE_SDF_ENCODING,
    },
    outline: {
      ...fileEntry(outlineName),
      encoding: PROVINCE_OUTLINE_ENCODING,
      points: outlinePoints,
    },
    provinceBBoxGrid,
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
        departments: deptEntry(
          "departments-half.bin",
          "province-sdf-half.bin",
          "province-outline-half.bin",
          outlineHalf.length / 2,
          halfSpec,
          provinceBBoxGridHalf,
        ),
      },
      high: {
        heights: heightsEntry(
          "heights-full.bin",
          DEM_GRID,
          elevationStats(heightsFull),
        ),
        satellite: satEntry("satellite-full.jpg", SATELLITE_GRID),
        departments: deptEntry(
          "departments-full.bin",
          "province-sdf-full.bin",
          "province-outline-full.bin",
          outlineFull.length / 2,
          DEM_GRID,
          provinceBBoxGridFull,
        ),
      },
    },
    boundaries: {
      file: fileEntry("departments.json"),
      provinceBBoxLonLat,
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
      boundaries: {
        file: basename(BOUNDS_PATH),
        path: "data/raw/" + basename(BOUNDS_PATH),
        bytes: statSync(BOUNDS_PATH).size,
        sha256: boundsSha,
      },
      attribution:
        "See ATTRIBUTIONS.md — DEM: Terrain Tiles (Mapzen / AWS Open Data, " +
        "Terrarium format; SRTM/GMTED2010/ETOPO1, public domain). " +
        "Imagery: Sentinel-2 cloudless 2016 by EOX IT Services GmbH, CC BY 4.0. " +
        "Department boundaries: geoBoundaries gbOpen ARG ADM2 (Instituto " +
        "Geográfico Nacional / UNHCR, OCHA ROLAC), CC BY 3.0 IGO.",
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
  const insideFull = deptFull.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
  console.log(
    `departments ${departments.length} (${departments[0]?.name} … ` +
      `${departments[departments.length - 1]?.name}), province ` +
      `covers ${((insideFull / deptFull.length) * 100).toFixed(1)}% of the grid, ` +
      `bbox lon/lat [${provinceBBoxLonLat.map((v) => v.toFixed(3)).join(", ")}], ` +
      `full grid cells [${provinceBBoxGridFull.join(", ")}], ` +
      `half grid cells [${provinceBBoxGridHalf.join(", ")}]`,
  );
  console.log(
    `half-res reconstruction error vs full-res: max ${reconError.maxAbsErrorMeters} m, ` +
      `mean ${reconError.meanAbsErrorMeters} m, p99 ${reconError.p99AbsErrorMeters} m, ` +
      `${(reconError.fractionOver20Meters * 100).toFixed(2)}% of cells over 20 m`,
  );
}

main();
