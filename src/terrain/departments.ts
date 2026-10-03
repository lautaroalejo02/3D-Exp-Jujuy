/**
 * Client loader for the department/province boundary data produced by the
 * data pipeline (pipeline v3+): a Uint8 department-index raster and the
 * Int8 province signed distance field for a quality level, plus the
 * department names and attribution from departments.json.
 *
 * Pure data access — nothing here touches the GPU or the DOM. It is not
 * wired into the app yet; the boundary overlay lands with the regions
 * feature.
 */
import type { GridSpec } from "../geo/grid";
import {
  TerrainHttpError,
  type FetchLike,
  type TerrainQuality,
} from "./heightfield";
import type { TerrainManifest } from "./manifest";

const defaultFetch: FetchLike = (url) => fetch(url);

/** departments.json schema version produced by the pipeline. */
export const DEPARTMENTS_SCHEMA_VERSION = 2;
/** Jujuy has 16 departments; indices run 1..16, 0 means outside. */
export const DEPARTMENT_COUNT = 16;

/** Thrown when departments.json or a raster payload fails validation. */
export class DepartmentsDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DepartmentsDataError";
  }
}

/** A department as listed in departments.json. */
export interface DepartmentInfo {
  /** Cell value in the index raster, 1..16. */
  readonly index: number;
  /**
   * Name verbatim from the geoBoundaries source's shapeName (e.g.
   * "Yaví") — names are never hand-written or canonicalized.
   */
  readonly name: string;
}

export interface DepartmentsData {
  readonly grid: GridSpec;
  /**
   * Department index per cell (row-major): 0 outside the province,
   * 1..16 = departments[index - 1].
   */
  readonly index: Uint8Array;
  /**
   * Signed distance to the province boundary in grid cells, clamped to
   * +/-127: positive inside, negative outside.
   */
  readonly sdf: Int8Array;
  /** Inclusive cell bounds of the province mask on `grid`. */
  readonly provinceBBoxGrid: readonly [number, number, number, number];
  /** Province extent [west, south, east, north] in degrees. */
  readonly provinceBBoxLonLat: readonly [number, number, number, number];
  /**
   * Departments sorted by index (index field is 1-based). The pipeline
   * assigns indices alphabetically by normalized source name.
   */
  readonly departments: readonly DepartmentInfo[];
  /** Attribution line for the boundary data, from departments.json. */
  readonly attribution: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertDepartmentsJson(value: unknown): asserts value is {
  schemaVersion: number;
  departments: DepartmentInfo[];
  attribution: string;
} {
  if (!isRecord(value) || value.schemaVersion !== DEPARTMENTS_SCHEMA_VERSION) {
    throw new DepartmentsDataError(
      `departments.json is missing or does not match schema version ` +
        DEPARTMENTS_SCHEMA_VERSION,
    );
  }
  const departments = value.departments;
  if (!Array.isArray(departments)) {
    throw new DepartmentsDataError(
      "departments.json has no departments array",
    );
  }
  if (departments.length !== DEPARTMENT_COUNT) {
    throw new DepartmentsDataError(
      `departments.json lists ${departments.length} departments, ` +
        `expected ${DEPARTMENT_COUNT}`,
    );
  }
  const seen = new Set<number>();
  for (const [k, d] of departments.entries()) {
    if (
      !isRecord(d) ||
      typeof d.index !== "number" ||
      typeof d.name !== "string"
    ) {
      throw new DepartmentsDataError(
        `departments.json entry ${k} is not {index, name}`,
      );
    }
    if (d.index < 1 || d.index > DEPARTMENT_COUNT || seen.has(d.index)) {
      throw new DepartmentsDataError(
        `departments.json entry ${k} has a duplicate or out-of-range ` +
          `index ${String(d.index)}`,
      );
    }
    seen.add(d.index);
  }
  if (typeof value.attribution !== "string") {
    throw new DepartmentsDataError("departments.json has no attribution");
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

function expectCells(
  bytes: Uint8Array,
  expectedBytes: number,
  cells: number,
  file: string,
): void {
  if (bytes.byteLength !== expectedBytes) {
    throw new DepartmentsDataError(
      `${file} is ${bytes.byteLength} B, manifest recorded ${expectedBytes} B`,
    );
  }
  if (bytes.byteLength !== cells) {
    throw new DepartmentsDataError(
      `${file} is ${bytes.byteLength} B, expected ${cells} ` +
        `(${cells} cells)`,
    );
  }
}

/**
 * Fetch and decode the department index raster, the province SDF and the
 * department metadata for a quality level. `baseUrl` prefixes the
 * manifest-relative file names, like loadHeightfield.
 *
 * Throws TerrainHttpError on HTTP errors and DepartmentsDataError when the
 * manifest predates pipeline v3 or a payload contradicts it.
 */
export async function loadDepartments(
  manifest: TerrainManifest,
  quality: TerrainQuality,
  fetchFn: FetchLike = defaultFetch,
  baseUrl = "",
): Promise<DepartmentsData> {
  const level = manifest.levels[quality];
  const deps = level.departments;
  const bounds = manifest.boundaries;
  if (!deps || !bounds) {
    throw new DepartmentsDataError(
      "terrain.json has no departments data; it was built before " +
        "pipeline v3 — run npm run build:data",
    );
  }
  const [indexBytes, sdfBytes, metaRes] = await Promise.all([
    fetchBytes(fetchFn, `${baseUrl}${deps.index.file}`),
    fetchBytes(fetchFn, `${baseUrl}${deps.sdf.file}`),
    fetchFn(`${baseUrl}${bounds.file.file}`),
  ]);
  if (!metaRes.ok) {
    throw new TerrainHttpError(`${baseUrl}${bounds.file.file}`, metaRes.status);
  }
  const meta: unknown = await metaRes.json();
  assertDepartmentsJson(meta);

  const cells = deps.index.grid.width * deps.index.grid.height;
  expectCells(indexBytes, deps.index.bytes, cells, deps.index.file);
  expectCells(sdfBytes, deps.sdf.bytes, cells, deps.sdf.file);
  // Int8 view of the same payload; DataView is unnecessary for single
  // bytes (endianness does not apply).
  const sdf = new Int8Array(
    sdfBytes.buffer,
    sdfBytes.byteOffset,
    sdfBytes.byteLength,
  );

  const sorted = [...meta.departments].sort((a, b) => a.index - b.index);
  return {
    grid: deps.index.grid,
    index: indexBytes,
    sdf,
    provinceBBoxGrid: deps.provinceBBoxGrid,
    provinceBBoxLonLat: bounds.provinceBBoxLonLat,
    departments: sorted,
    attribution: meta.attribution,
  };
}
