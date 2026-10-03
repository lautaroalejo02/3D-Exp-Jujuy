/**
 * Client loader for the hydrology rasters produced by
 * scripts/build-flow.ts: flow.json + flow-dir.bin (Uint8 D8),
 * flow-acc.bin (Uint16-LE log2 acc) and flow-basins.bin (Uint8 labels).
 *
 * Pure data access — nothing here touches the GPU or the DOM.
 */
import type { GridSpec } from "../../geo/grid";
import {
  TerrainHttpError,
  type FetchLike,
} from "../../terrain/heightfield";
import { ACC_LOG2_SCALE } from "./flow";

const defaultFetch: FetchLike = (url) => fetch(url);

/** flow.json schema version produced by the pipeline. */
export const FLOW_SCHEMA_VERSION = 2;

/**
 * Basin end type: "cerrada" basins are endorheic — their water ends in
 * an interior laguna/salar and never reaches the sea; "abierta" basins
 * drain to a province-boundary outlet.
 */
export type BasinKind = "cerrada" | "abierta";

/** Thrown when flow.json or a raster payload fails validation. */
export class FlowDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowDataError";
  }
}

/** A main drainage basin as listed in flow.json (id 1..N; 0 = "otras"). */
export interface FlowBasinInfo {
  readonly id: number;
  /** End type: closed interior sink vs boundary outlet. */
  readonly kind: BasinKind;
  /** In-province cells in the basin. */
  readonly cells: number;
  /**
   * Largest accumulation among the basin's in-province cells (upstream
   * cell count of its main river where it crosses the boundary, or at
   * the sink bottom for a cerrada basin).
   */
  readonly outletAcc: number;
  /** Grid coords of that pour point. */
  readonly outlet: readonly [number, number];
  /** Lon/lat of that pour point. */
  readonly outletLonLat: readonly [number, number];
  /** Department index (1..16, departments.json) the pour point is in. */
  readonly outletDepartmentIndex: number;
  /**
   * Grid coords of the flow terminal: the boundary sink (abierta) or
   * the retained depression's pit bottom (cerrada).
   */
  readonly terminal: readonly [number, number];
  /** Lon/lat of that terminal. */
  readonly terminalLonLat: readonly [number, number];
  /**
   * Name of the laguna/salar the basin ends in — cerrada basins only,
   * and only when a water-named place sits near the terminal.
   */
  readonly sinkName?: string;
}

export interface FlowData {
  readonly grid: GridSpec;
  /**
   * D8 direction per cell: 0 = no outflow (edge sink), 1..8 = E,SE,S,SW,
   * W,NW,N,NE. Row-major on `grid`.
   */
  readonly dir: Uint8Array;
  /**
   * log2(upstream cells) * ACC_LOG2_SCALE per cell. Multiply-free decode:
   * acc ≈ 2 ** (v / ACC_LOG2_SCALE).
   */
  readonly accLog2: Uint16Array;
  /**
   * Basin label per cell: 255 outside the province, 0 "otras",
   * 1..basins.length a main basin (sorted by outletAcc, largest first).
   */
  readonly basins: Uint8Array;
  readonly basinInfos: readonly FlowBasinInfo[];
  /** Accumulation threshold marking the emphasized river network. */
  readonly riverAcc: number;
  /** Attribution line for the hydrology data, from flow.json. */
  readonly attribution: string;
}

interface FlowFileEntry {
  file: string;
  bytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertFileEntry(
  value: unknown,
  name: string,
): asserts value is FlowFileEntry {
  if (
    !isRecord(value) ||
    typeof value.file !== "string" ||
    typeof value.bytes !== "number"
  ) {
    throw new FlowDataError(`flow.json entry for ${name} is malformed`);
  }
}

function assertGrid(value: unknown): asserts value is GridSpec {
  if (
    !isRecord(value) ||
    typeof value.zoom !== "number" ||
    !Array.isArray(value.originPx) ||
    typeof value.originPx[0] !== "number" ||
    typeof value.originPx[1] !== "number" ||
    typeof value.width !== "number" ||
    typeof value.height !== "number" ||
    typeof value.scale !== "number"
  ) {
    throw new FlowDataError("flow.json has no valid grid spec");
  }
}

interface FlowJson {
  grid: GridSpec;
  files: {
    "flow-dir.bin": FlowFileEntry;
    "flow-acc.bin": FlowFileEntry;
    "flow-basins.bin": FlowFileEntry;
  };
  basins: FlowBasinInfo[];
  riverAcc: number;
  sources: { attribution: string };
}

function assertFlowJson(value: unknown): asserts value is FlowJson {
  if (
    !isRecord(value) ||
    value.schemaVersion !== FLOW_SCHEMA_VERSION ||
    typeof value.pipelineVersion !== "number"
  ) {
    throw new FlowDataError(
      `flow.json is missing or does not match schema version ` +
        FLOW_SCHEMA_VERSION,
    );
  }
  assertGrid(value.grid);
  const files = value.files;
  if (!isRecord(files)) {
    throw new FlowDataError("flow.json has no files map");
  }
  const entries = files as Record<string, unknown>;
  assertFileEntry(entries["flow-dir.bin"], "flow-dir.bin");
  assertFileEntry(entries["flow-acc.bin"], "flow-acc.bin");
  assertFileEntry(entries["flow-basins.bin"], "flow-basins.bin");
  if (!Array.isArray(value.basins)) {
    throw new FlowDataError("flow.json has no basins array");
  }
  for (const [k, b] of value.basins.entries()) {
    if (
      !isRecord(b) ||
      typeof b.id !== "number" ||
      (b.kind !== "cerrada" && b.kind !== "abierta") ||
      typeof b.cells !== "number" ||
      typeof b.outletAcc !== "number" ||
      typeof b.outletDepartmentIndex !== "number" ||
      !Array.isArray(b.outlet) ||
      !Array.isArray(b.outletLonLat) ||
      !Array.isArray(b.terminal) ||
      !Array.isArray(b.terminalLonLat) ||
      (b.sinkName !== undefined && typeof b.sinkName !== "string")
    ) {
      throw new FlowDataError(`flow.json basin entry ${k} is malformed`);
    }
  }
  if (typeof value.riverAcc !== "number") {
    throw new FlowDataError("flow.json has no riverAcc");
  }
  const sources = value.sources;
  if (!isRecord(sources) || typeof sources.attribution !== "string") {
    throw new FlowDataError("flow.json has no sources.attribution");
  }
}

async function fetchBytes(
  fetchFn: FetchLike,
  url: string,
): Promise<Uint8Array> {
  const res = await fetchFn(url);
  if (!res.ok) throw new TerrainHttpError(url, res.status);
  return new Uint8Array(await res.arrayBuffer());
}

function expectBytes(
  bytes: Uint8Array,
  expected: number,
  file: string,
): void {
  if (bytes.byteLength !== expected) {
    throw new FlowDataError(
      `${file} is ${bytes.byteLength} B, manifest recorded ${expected} B`,
    );
  }
}

/**
 * Fetch and validate flow.json plus the three hydrology rasters.
 * `baseUrl` prefixes the manifest-relative file names, like
 * loadHeightfield. Cell counts and byte sizes are checked against the
 * manifest; a mismatch means the pipeline and the app disagree.
 */
export async function loadFlowData(
  fetchFn: FetchLike = defaultFetch,
  baseUrl = "",
): Promise<FlowData> {
  const metaRes = await fetchFn(`${baseUrl}flow.json`);
  if (!metaRes.ok) {
    throw new TerrainHttpError(`${baseUrl}flow.json`, metaRes.status);
  }
  const meta: unknown = await metaRes.json();
  assertFlowJson(meta);
  const cells = meta.grid.width * meta.grid.height;

  const [dirBytes, accBytes, basinBytes] = await Promise.all([
    fetchBytes(fetchFn, `${baseUrl}${meta.files["flow-dir.bin"].file}`),
    fetchBytes(fetchFn, `${baseUrl}${meta.files["flow-acc.bin"].file}`),
    fetchBytes(fetchFn, `${baseUrl}${meta.files["flow-basins.bin"].file}`),
  ]);
  expectBytes(dirBytes, meta.files["flow-dir.bin"].bytes, "flow-dir.bin");
  expectBytes(accBytes, meta.files["flow-acc.bin"].bytes, "flow-acc.bin");
  expectBytes(
    basinBytes,
    meta.files["flow-basins.bin"].bytes,
    "flow-basins.bin",
  );
  if (dirBytes.byteLength !== cells) {
    throw new FlowDataError(
      `flow-dir.bin holds ${dirBytes.byteLength} cells, expected ${cells}`,
    );
  }
  if (accBytes.byteLength !== cells * 2) {
    throw new FlowDataError(
      `flow-acc.bin holds ${accBytes.byteLength} B, expected ${cells * 2}`,
    );
  }
  if (basinBytes.byteLength !== cells) {
    throw new FlowDataError(
      `flow-basins.bin holds ${basinBytes.byteLength} cells, ` +
        `expected ${cells}`,
    );
  }

  // Uint16-LE payload: DataView-independent view is fine on little-endian
  // hosts, but decode explicitly so big-endian platforms behave the same.
  const accLog2 = new Uint16Array(cells);
  const view = new DataView(
    accBytes.buffer,
    accBytes.byteOffset,
    accBytes.byteLength,
  );
  for (let k = 0; k < cells; k++) accLog2[k] = view.getUint16(k * 2, true);

  return {
    grid: meta.grid,
    dir: dirBytes,
    accLog2,
    basins: basinBytes,
    basinInfos: meta.basins,
    riverAcc: meta.riverAcc,
    attribution: meta.sources.attribution,
  };
}

/** Decode an accLog2 cell to an upstream-cell count approximation. */
export function decodeAcc(accLog2Value: number): number {
  return 2 ** (accLog2Value / ACC_LOG2_SCALE);
}
