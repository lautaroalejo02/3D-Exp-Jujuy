import type { GridSpec } from "../geo/grid";

export const TERRAIN_SCHEMA_VERSION = 1;

export interface TerrainFileEntry {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface HeightEncoding {
  readonly format: "int16";
  readonly endianness: "little";
  readonly units: "meters";
  readonly layout: "row-major";
}

export interface ElevationStats {
  readonly minMeters: number;
  readonly maxMeters: number;
  readonly meanMeters: number;
  /**
   * 0.1% percentile. Robust low bound: the raw min is a ~7 px source-data
   * pit (~26 m surrounded by ~300 m terrain), not a decode bug.
   */
  readonly p001Meters: number;
  /** 99.9% percentile; robust high bound. */
  readonly p999Meters: number;
}

/**
 * Error of reconstructing the full-res grid from a downsampled level:
 * per full-res cell, |full height - bilinear sample of the coarse grid|
 * at the cell's center.
 */
export interface ReconstructionError {
  readonly maxAbsErrorMeters: number;
  readonly meanAbsErrorMeters: number;
  readonly p99AbsErrorMeters: number;
  readonly fractionOver20Meters: number;
}

/**
 * Department index raster encoding: one byte per cell, row-major.
 * 0 = outside the province, 1..16 = department (index order is
 * departments.json's, which is alphabetical by normalized source
 * name — the geoBoundaries shapeName).
 */
export const DEPARTMENT_INDEX_ENCODING = {
  format: "uint8",
  layout: "row-major",
  semantics: "department-index",
} as const;
export type DepartmentIndexEncoding = typeof DEPARTMENT_INDEX_ENCODING;

/**
 * Signed distance to the province boundary in grid cells, Int8 row-major:
 * positive inside the province, negative outside, clamped to +/-127.
 */
export const PROVINCE_SDF_ENCODING = {
  format: "int8",
  layout: "row-major",
  units: "cells",
  clamp: 127,
} as const;
export type ProvinceSdfEncoding = typeof PROVINCE_SDF_ENCODING;

/**
 * Province outline ring: Float32 little-endian pairs [i, j] in the
 * level's grid coords (cell centers at integers), the iso-0 contour of
 * the level's province SDF, simplified with Douglas-Peucker and wound
 * with positive signed area — the diorama's cut wall follows it.
 * Present since pipeline v4.
 */
export const PROVINCE_OUTLINE_ENCODING = {
  format: "float32",
  endianness: "little",
  layout: "pairs",
  semantics: "closed-ring",
  units: "grid-cells",
  winding: "positive-area",
} as const;
export type ProvinceOutlineEncoding = typeof PROVINCE_OUTLINE_ENCODING;

/** Department index raster + province SDF for one quality level. */
export interface DepartmentsLevel {
  readonly index: TerrainFileEntry & {
    readonly grid: GridSpec;
    readonly encoding: DepartmentIndexEncoding;
  };
  readonly sdf: TerrainFileEntry & {
    readonly encoding: ProvinceSdfEncoding;
  };
  /**
   * Province outline ring (pipeline v4+); absent in manifests built
   * before it — the diorama then draws no cut wall.
   */
  readonly outline?: TerrainFileEntry & {
    readonly encoding: ProvinceOutlineEncoding;
    /** Vertices in the ring (= bytes / 8). */
    readonly points: number;
  };
  /**
   * Inclusive cell bounds [minI, minJ, maxI, maxJ] of the province mask on
   * this level's grid.
   */
  readonly provinceBBoxGrid: readonly [number, number, number, number];
}

export interface TerrainLevel {
  readonly heights: TerrainFileEntry & {
    readonly grid: GridSpec;
    readonly encoding: HeightEncoding;
    readonly elevation: ElevationStats;
    /** Only on levels derived by downsampling the full-res grid. */
    readonly reconstructionError?: ReconstructionError;
  };
  readonly satellite: TerrainFileEntry & { readonly grid: GridSpec };
  /** Present since pipeline v3; absent in manifests built before it. */
  readonly departments?: DepartmentsLevel;
}

export interface TerrainManifest {
  readonly schemaVersion: number;
  /**
   * Version of the data pipeline that produced these outputs
   * (PIPELINE_VERSION in scripts/build-data.ts). Part of the build cache
   * key so stale outputs are rebuilt; not used at runtime.
   */
  readonly pipelineVersion: number;
  readonly levels: {
    readonly default: TerrainLevel;
    readonly high: TerrainLevel;
  };
  /**
   * Department/province boundary data (departments.json plus, per level,
   * the index raster and SDF). Present since pipeline v3.
   */
  readonly boundaries?: {
    readonly file: TerrainFileEntry;
    /**
     * Province extent [west, south, east, north] in degrees: the union of
     * the 16 department polygons, computed from the source vectors.
     */
    readonly provinceBBoxLonLat: readonly [number, number, number, number];
  };
  readonly sources: {
    readonly dem: TerrainFileEntry & { readonly path: string };
    readonly satellite: TerrainFileEntry & { readonly path: string };
    /** Present since pipeline v3. */
    readonly boundaries?: TerrainFileEntry & { readonly path: string };
    readonly attribution: string;
  };
}
