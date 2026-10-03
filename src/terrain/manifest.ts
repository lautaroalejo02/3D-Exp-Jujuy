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

export interface TerrainLevel {
  readonly heights: TerrainFileEntry & {
    readonly grid: GridSpec;
    readonly encoding: HeightEncoding;
    readonly elevation: ElevationStats;
    /** Only on levels derived by downsampling the full-res grid. */
    readonly reconstructionError?: ReconstructionError;
  };
  readonly satellite: TerrainFileEntry & { readonly grid: GridSpec };
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
  readonly sources: {
    readonly dem: TerrainFileEntry & { readonly path: string };
    readonly satellite: TerrainFileEntry & { readonly path: string };
    readonly attribution: string;
  };
}
