/**
 * Flow pipeline: data/build -> data/build (run after build-data).
 *
 * Reads the half-resolution DEM (heights-half.bin) and the department
 * index raster on the same grid (departments-half.bin), then:
 *
 * - fills SMALL depressions only (priority-flood + epsilon, Barnes et
 *   al. 2014; src/modes/agua/flow.ts): the Puna is endorheic — its big
 *   closed basins (Pozuelos, Guayatayoc, the salares) stay terminal
 *   sinks where flow ends, not spill points into an artificial outlet,
 * - derives D8 flow direction and upstream accumulation over the WHOLE
 *   grid (the province edge and the retained pit bottoms are the sinks,
 *   so rivers entering Jujuy carry their real upstream cells),
 * - labels the main drainage basins: in-province cells are grouped by
 *   the terminal cell of their flow path — basins whose terminal sits
 *   inside the province are "cerrada" (endorheic), the rest "abierta",
 *   and the top MAX_MAIN_BASINS groups by accumulation are kept — the
 *   rest are "otras",
 * - writes flow-dir.bin (Uint8), flow-acc.bin (Uint16-LE,
 *   log2(acc)*256), flow-basins.bin (Uint8; 255 outside, 0 otras,
 *   1..N main), a debug-flow.png preview (not shipped) and flow.json.
 *
 * Deterministic and cached like build-data: flow.json records the input
 * file hashes (the build-data outputs this consumes) and every output's
 * size+sha256; a rerun with matching inputs and outputs prints
 * "up to date". `--force` rebuilds.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PNG } from "pngjs";

import {
  gridToLonLat,
  lonLatToGrid,
} from "../src/geo/grid";
import { metersPerGridCell } from "../src/geo/world";
import {
  ACC_LOG2_SCALE,
  BASIN_OUTSIDE,
  buildSpawnCells,
  depressionIsRetained,
  encodeAccLog2,
  FILL_AREA_CELLS,
  FILL_DEPTH_METERS,
  findDepressions,
  flowAccumulation,
  flowDirectionsD8,
  FLOW_DIR_NONE,
  flowTarget,
  labelBasins,
  MAX_MAIN_BASINS,
  priorityFloodFill,
  riverThreshold,
  routeElevations,
} from "../src/modes/agua/flow";
import { decodeHeightsLE } from "../src/terrain/encoding";
import type { TerrainManifest } from "../src/terrain/manifest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = join(ROOT, "data/build");

/** Bump when decoding/algorithms change so stale outputs are rebuilt. */
const FLOW_PIPELINE_VERSION = 2;

const OUTPUT_FILES = [
  "flow-dir.bin",
  "flow-acc.bin",
  "flow-basins.bin",
  "flow.json",
] as const;

/** Fraction of in-province cells the river emphasis highlights. */
const RIVER_FRACTION = 0.015;

/**
 * Sink naming: a cerrada basin's terminal is matched to a
 * laguna/salar-named place within this radius (km). Towns are never a
 * sink's name — unmatched terminals fall back to "laguna o salar".
 */
const SINK_NAME_RADIUS_KM = 25;

interface PlaceRef {
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
}

/** Raw places.json entries — each field is validated where it is used. */
interface PlaceEntry {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly lat?: unknown;
  readonly lon?: unknown;
}

/**
 * places.json (built by build:places) supplies the laguna/salar names
 * for the cerrada basins and the verification coordinates. It is an
 * INPUT, not a requirement: when it is absent or unreadable the build
 * still runs and closed basins fall back to "laguna o salar". Parsed
 * once here; `parseError` carries the JSON failure for the warning.
 */
function loadPlaces(placesBytes: Buffer | undefined): {
  entries: PlaceEntry[];
  parseError: string | undefined;
} {
  if (!placesBytes) return { entries: [], parseError: undefined };
  try {
    const doc = JSON.parse(placesBytes.toString("utf8")) as {
      places?: PlaceEntry[];
    };
    return {
      entries: Array.isArray(doc.places) ? doc.places : [],
      parseError: undefined,
    };
  } catch (error) {
    return {
      entries: [],
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Rough km between two lon/lat points (good enough for basin naming). */
function kmBetween(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dx = (lon2 - lon1) * 111 * Math.cos((lat1 * Math.PI) / 180);
  const dy = (lat2 - lat1) * 111;
  return Math.hypot(dx, dy);
}

const WATER_NAME = /laguna|salar|pozuelo/i;

/**
 * Name for a cerrada basin's sink: the nearest laguna/salar-named place
 * inside SINK_NAME_RADIUS_KM, else "laguna o salar".
 */
function sinkName(places: PlaceRef[], lon: number, lat: number): string {
  const ranked = places
    .map((p) => ({ p, d: kmBetween(lon, lat, p.lon, p.lat) }))
    .sort((a, b) => a.d - b.d);
  const water = ranked.find(
    (r) => r.d <= SINK_NAME_RADIUS_KM && WATER_NAME.test(r.p.name),
  );
  return water?.p.name ?? "laguna o salar";
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileEntry(name: string): {
  file: string;
  bytes: number;
  sha256: string;
} {
  const bytes = readFileSync(join(OUT_DIR, name));
  return { file: name, bytes: bytes.length, sha256: sha256(bytes) };
}

function checkPreviousBuild(
  heightsSha: string,
  departmentsSha: string,
  placesSha: string,
): string | undefined {
  const manifestPath = join(OUT_DIR, "flow.json");
  if (!existsSync(manifestPath)) return "flow.json is missing";
  try {
    const prev = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      pipelineVersion?: number;
      inputs?: {
        heights?: { sha256?: string };
        departments?: { sha256?: string };
        places?: { sha256?: string };
      };
      files?: Record<string, { file?: string; bytes?: number; sha256?: string }>;
    };
    if (prev.pipelineVersion !== FLOW_PIPELINE_VERSION) {
      return `flow pipeline version changed (${String(prev.pipelineVersion)} -> ${FLOW_PIPELINE_VERSION})`;
    }
    if (prev.inputs?.heights?.sha256 !== heightsSha) {
      return "heights input hash changed";
    }
    if (prev.inputs?.departments?.sha256 !== departmentsSha) {
      return "departments input hash changed";
    }
    if (prev.inputs?.places?.sha256 !== placesSha) {
      return "places input changed (basin naming source)";
    }
    for (const name of OUTPUT_FILES) {
      if (name === "flow.json") continue;
      const entry = prev.files?.[name];
      if (!entry?.file) return `flow.json does not list ${name}`;
      const path = join(OUT_DIR, name);
      if (!existsSync(path)) return `missing output ${name}`;
      const bytes = readFileSync(path);
      if (bytes.length !== entry.bytes) {
        return `${name} is ${bytes.length} B, manifest recorded ${entry.bytes} B`;
      }
      if (sha256(bytes) !== entry.sha256) {
        return `${name} sha256 does not match flow.json`;
      }
    }
    return undefined;
  } catch {
    return "flow.json is unreadable";
  }
}

/** Distinct basin colors for the debug preview (same hues as the app). */
const BASIN_COLORS: readonly (readonly [number, number, number])[] = [
  [86, 180, 233],
  [230, 159, 0],
  [0, 158, 115],
  [204, 121, 167],
  [0, 114, 178],
  [240, 228, 66],
  [213, 94, 0],
  [120, 180, 60],
];

function main(): void {
  const force = process.argv.includes("--force");
  const heightsPath = join(OUT_DIR, "heights-half.bin");
  const departmentsPath = join(OUT_DIR, "departments-half.bin");
  for (const path of [heightsPath, departmentsPath]) {
    if (!existsSync(path)) {
      throw new Error(
        `${path} is missing — run "npm run build:data" first`,
      );
    }
  }
  const heightsBytes = readFileSync(heightsPath);
  const departmentsBytes = readFileSync(departmentsPath);
  const heightsSha = sha256(heightsBytes);
  const departmentsSha = sha256(departmentsBytes);
  // Basin naming + verification source (optional input — see loadPlaces).
  const placesPath = join(OUT_DIR, "places.json");
  const placesBytes = existsSync(placesPath)
    ? readFileSync(placesPath)
    : undefined;
  const placesSha = placesBytes ? sha256(placesBytes) : "absent";

  if (!force) {
    const reason = checkPreviousBuild(heightsSha, departmentsSha, placesSha);
    if (!reason) {
      console.log("up to date");
      return;
    }
    console.log(`${reason}; rebuilding`);
  }

  const manifest = JSON.parse(
    readFileSync(join(OUT_DIR, "terrain.json"), "utf8"),
  ) as TerrainManifest;
  const flowGrid = manifest.levels.default.heights.grid;
  const { width, height } = flowGrid;
  const cells = width * height;

  const heights = decodeHeightsLE(heightsBytes);
  if (heights.length !== cells) {
    throw new Error(
      `heights-half.bin decoded to ${heights.length} cells, ` +
        `expected ${cells} (${width}x${height})`,
    );
  }
  const deptIndex = new Uint8Array(
    departmentsBytes.buffer,
    departmentsBytes.byteOffset,
    departmentsBytes.byteLength,
  );
  if (deptIndex.length !== cells) {
    throw new Error(
      `departments-half.bin is ${deptIndex.length} cells, ` +
        `expected ${cells} (${width}x${height})`,
    );
  }
  const departmentsDoc = JSON.parse(
    readFileSync(join(OUT_DIR, "departments.json"), "utf8"),
  ) as { departments: { index: number; name: string }[] };

  const heightsF32 = Float32Array.from(heights);
  const inside = Uint8Array.from(deptIndex, (v) => (v > 0 ? 1 : 0));

  // Parsed once — the entries also feed the verification block below.
  const { entries: rawPlaces, parseError: placesParseError } =
    loadPlaces(placesBytes);
  const places: PlaceRef[] = rawPlaces
    .filter(
      (p): p is { name: string; lat: number; lon: number } =>
        typeof p.name === "string" &&
        typeof p.lat === "number" &&
        typeof p.lon === "number",
    )
    .map((p) => ({ name: p.name, lat: p.lat, lon: p.lon }));
  if (places.length === 0) {
    console.warn(
      "places.json missing/unreadable" +
        (placesParseError ? ` (${placesParseError})` : "") +
        " — cerrada basins get the " +
        '"laguna o salar" fallback names (run npm run build:places)',
    );
  }

  console.log("priority-flood fill + depression analysis…");
  const t0 = performance.now();
  // Two floods: the epsilon fill (routing surface outside depressions)
  // and the minimal fill (ponded mask — only genuinely closed cells rise
  // above their raw height).
  const { filled } = priorityFloodFill(heightsF32, width, height);
  const { filled: filledMin } = priorityFloodFill(
    heightsF32,
    width,
    height,
    0,
  );
  const depressions = findDepressions(
    heightsF32,
    filledMin,
    width,
    height,
  );
  const z = routeElevations(
    heightsF32,
    filled,
    filledMin,
    depressions,
    width,
    height,
  );
  const dir = flowDirectionsD8(z, width, height);
  const acc = flowAccumulation(dir, z, width, height);
  const { labels, basins } = labelBasins(
    dir,
    inside,
    acc,
    width,
    height,
    MAX_MAIN_BASINS,
    depressions,
  );
  const accLog = encodeAccLog2(acc);
  const spawnCells = buildSpawnCells(inside, width, height);
  const riverAcc = riverThreshold(acc, inside, RIVER_FRACTION);
  console.log(
    `hydrology done in ${(performance.now() - t0).toFixed(0)} ms`,
  );

  const cellKm2 = (metersPerGridCell(flowGrid) / 1000) ** 2;
  const retained = depressions.list
    .map((d, id) => ({ d, id }))
    .filter(({ d }) => depressionIsRetained(d))
    .sort((a, b) => b.d.cells - a.d.cells);
  console.log(
    `depressions: ${depressions.list.length} ponded components, ` +
      `${retained.length} retained as terminal sinks ` +
      `(>= ${FILL_AREA_CELLS} cells and >= ${FILL_DEPTH_METERS} m deep)`,
  );
  for (const { d } of retained.slice(0, 12)) {
    const [blon, blat] = gridToLonLat(
      flowGrid,
      d.bottomCell % width,
      (d.bottomCell / width) | 0,
    );
    console.log(
      `  sink: ${d.cells} cells (${(d.cells * cellKm2).toFixed(1)} km²), ` +
        `depth ${d.depthMeters.toFixed(1)} m, ` +
        `bottom [${blon.toFixed(3)}, ${blat.toFixed(3)}]`,
    );
  }

  let raised = 0;
  let insideCount = 0;
  let maxAcc = 0;
  let interiorSinks = 0;
  for (let k = 0; k < cells; k++) {
    if ((filled[k] ?? 0) > (heightsF32[k] ?? 0) + 0.015) raised++;
    if (inside[k]) {
      insideCount++;
      if ((acc[k] ?? 0) > maxAcc) maxAcc = acc[k] ?? 0;
      if (dir[k] === FLOW_DIR_NONE) interiorSinks++;
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, "flow-dir.bin"),
    Buffer.from(dir.buffer, dir.byteOffset, dir.byteLength),
  );
  writeFileSync(
    join(OUT_DIR, "flow-acc.bin"),
    Buffer.from(accLog.buffer, accLog.byteOffset, accLog.byteLength),
  );
  writeFileSync(
    join(OUT_DIR, "flow-basins.bin"),
    Buffer.from(labels.buffer, labels.byteOffset, labels.byteLength),
  );

  const doc = {
    schemaVersion: 2,
    pipelineVersion: FLOW_PIPELINE_VERSION,
    grid: flowGrid,
    files: {
      "flow-dir.bin": {
        ...fileEntry("flow-dir.bin"),
        encoding: "uint8",
        semantics: "d8-flow-direction",
        codes: "0 none; 1 E, 2 SE, 3 S, 4 SW, 5 W, 6 NW, 7 N, 8 NE",
      },
      "flow-acc.bin": {
        ...fileEntry("flow-acc.bin"),
        encoding: "uint16-le",
        semantics: "log2-upstream-cells",
        scale: ACC_LOG2_SCALE,
      },
      "flow-basins.bin": {
        ...fileEntry("flow-basins.bin"),
        encoding: "uint8",
        semantics: "basin-id",
        outside: BASIN_OUTSIDE,
        other: 0,
      },
    },
    basins: basins.map((b) => {
      const [oi, oj] = b.outlet;
      const [lon, lat] = gridToLonLat(flowGrid, oi, oj);
      const [ti, tj] = b.terminal;
      const [tlon, tlat] = gridToLonLat(flowGrid, ti, tj);
      return {
        id: b.id,
        kind: b.kind,
        cells: b.cells,
        outletAcc: b.outletAcc,
        outlet: b.outlet,
        outletLonLat: [lon, lat] as [number, number],
        outletDepartmentIndex: deptIndex[oj * width + oi] ?? 0,
        terminal: b.terminal,
        terminalLonLat: [tlon, tlat] as [number, number],
        ...(b.kind === "cerrada"
          ? { sinkName: sinkName(places, tlon, tlat) }
          : {}),
      };
    }),
    riverAcc,
    stats: {
      cells,
      insideCells: insideCount,
      spawnCells: spawnCells.length,
      filledRaised: raised,
      maxAccInside: maxAcc,
      interiorSinks,
      depressions: depressions.list.length,
      retainedDepressions: retained.length,
      fillAreaCells: FILL_AREA_CELLS,
      fillDepthMeters: FILL_DEPTH_METERS,
      mainBasins: MAX_MAIN_BASINS,
      riverFraction: RIVER_FRACTION,
    },
    inputs: {
      heights: { file: "heights-half.bin", sha256: heightsSha },
      departments: { file: "departments-half.bin", sha256: departmentsSha },
      places: {
        file: placesBytes ? "places.json" : "(absent)",
        sha256: placesSha,
      },
    },
    sources: {
      method:
        "Priority-flood + epsilon (Barnes et al. 2014) with selective " +
        "depression retention — depressions >= " +
        `${FILL_AREA_CELLS} cells and >= ${FILL_DEPTH_METERS} m deep ` +
        "stay terminal (endorheic) sinks — D8 direction, upstream " +
        "accumulation and pour-point basin grouping — computed " +
        "by scripts/build-flow.ts over the project DEM and boundary " +
        "rasters (see ATTRIBUTIONS.md).",
      attribution:
        "Escurrimiento y cuencas calculados sobre el DEM Terrarium " +
        "(Mapzen/AWS Open Data, SRTM) y los límites geoBoundaries. " +
        "Ver Fuentes de datos.",
    },
  };
  writeFileSync(
    join(OUT_DIR, "flow.json"),
    JSON.stringify(doc, null, 2) + "\n",
  );

  // Debug preview (not shipped — pruned from dist): basin colors over a
  // dark base, bright blue where acc crosses the river threshold, grey
  // "otras" inside cells, black outside, white dots on interior sinks
  // (the endorheic pit bottoms).
  const px = new Uint8Array(cells * 4);
  for (let k = 0; k < cells; k++) {
    const o = k * 4;
    const b = labels[k] ?? 0;
    if (b === BASIN_OUTSIDE) {
      px[o + 3] = 255;
      continue;
    }
    if (dir[k] === FLOW_DIR_NONE) {
      px[o] = 255;
      px[o + 1] = 255;
      px[o + 2] = 255;
      px[o + 3] = 255;
      continue;
    }
    const river = (acc[k] ?? 0) >= riverAcc;
    const color =
      b === 0
        ? ([110, 110, 110] as const)
        : BASIN_COLORS[b % BASIN_COLORS.length] ?? [0, 0, 0];
    px[o] = river ? 40 : color[0];
    px[o + 1] = river ? 120 : color[1];
    px[o + 2] = river ? 255 : color[2];
    px[o + 3] = 255;
  }
  const debugPng = new PNG({ width, height });
  debugPng.data = Buffer.from(px.buffer, px.byteOffset, px.byteLength);
  writeFileSync(join(OUT_DIR, "debug-flow.png"), PNG.sync.write(debugPng));

  console.log(
    `cells ${cells} | inside ${insideCount} | raised ${raised} | ` +
      `maxAcc(inside) ${maxAcc} | interior sinks ${interiorSinks} | ` +
      `riverAcc>=${riverAcc}`,
  );
  for (const b of doc.basins) {
    const dept = departmentsDoc.departments.find(
      (d) => d.index === b.outletDepartmentIndex,
    )?.name;
    const end =
      b.kind === "cerrada"
        ? `termina en ${"sinkName" in b ? String(b.sinkName) : "laguna o salar"} ` +
          `[${b.terminalLonLat[0].toFixed(3)}, ${b.terminalLonLat[1].toFixed(3)}]`
        : `desagua hacia ${dept ?? "el borde"} ` +
          `[${b.outletLonLat[0].toFixed(3)}, ${b.outletLonLat[1].toFixed(3)}]`;
    console.log(
      `  basin ${b.id} (${b.kind}): cells ${b.cells}, ` +
        `acc ${b.outletAcc} — ${end}`,
    );
  }

  // Endorheic verification: the Puna lagunas must terminate inside the
  // province. Coordinates come from places.json (sourced, Wikidata/OSM);
  // each print reports the cell's accumulation and its basin type.
  const verification = [
    { id: "Q830120", name: "Laguna de los Pozuelos" },
    { id: "Q1388407", name: "Laguna de Guayatayoc" },
    { id: "Q2893104", name: "Salinas Grandes" },
  ];
  let verified = 0;
  for (const v of verification) {
    const place = rawPlaces.find((p) => p.id === v.id);
    if (
      !place ||
      typeof place.lat !== "number" ||
      typeof place.lon !== "number"
    ) {
      console.warn(
        `  ${v.name}: place ${v.id} not in places.json — skipped`,
      );
      continue;
    }
    const [fi, fj] = lonLatToGrid(flowGrid, place.lon, place.lat);
    const ci = Math.round(fi);
    const cj = Math.round(fj);
    const cell = cj * width + ci;
    // Walk the flow path to its terminal.
    let c = cell;
    for (let steps = 0; steps < cells; steps++) {
      const t = flowTarget(dir, c, width, height);
      if (t < 0) break;
      c = t;
    }
    const [tlon, tlat] = gridToLonLat(
      flowGrid,
      c % width,
      (c / width) | 0,
    );
    const basinId = labels[cell] ?? 0;
    const basin = doc.basins.find((b) => b.id === basinId);
    const interior = inside[c] === 1;
    const kind = interior ? "cerrada" : "abierta";
    if (interior) verified++;
    console.log(
      `  ${v.name}: cell (${ci},${cj}) acc ${Math.round(acc[cell] ?? 0)}, ` +
        `dir ${dir[cell]} -> terminal (${c % width},${(c / width) | 0}) ` +
        `[${tlon.toFixed(3)}, ${tlat.toFixed(3)}] — ` +
        `cuenca ${kind}${basin ? ` (basin ${basin.id}: ${basin.kind})` : " (otras)"}`,
    );
  }
  if (verified < verification.length && places.length > 0) {
    console.warn(
      `WARNING: ${verification.length - verified} verification laguna(s) ` +
        "do not terminate inside the province",
    );
  }
}

main();
