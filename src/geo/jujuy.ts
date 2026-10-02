import type { GridSpec } from "./grid";
import { TILE_SIZE } from "./slippy";

/**
 * Project grids for the Jujuy maqueta. Every number below is derived from
 * the tile ranges of the downloaded mosaics — never hand-computed
 * coordinates.
 *
 * DEM mosaic (Terrarium): z10, tiles x 320..329, y 575..584.
 * Cropped DEM grid: starts 128 px into the mosaic on the west edge
 * (320*256 + 128), 2432 x 2560 cells. Its extent matches the satellite
 * mosaic exactly (asserted in grid.test.ts).
 * Satellite mosaic (Sentinel-2 cloudless): z11, tiles x 641..659,
 * y 1150..1169 — 4864 x 5120 cells at 2x the DEM resolution.
 */

export const DEM_MOSAIC_GRID: GridSpec = {
  zoom: 10,
  originPx: [320 * TILE_SIZE, 575 * TILE_SIZE],
  width: 10 * TILE_SIZE,
  height: 10 * TILE_SIZE,
  scale: 1,
};

export const DEM_GRID: GridSpec = {
  zoom: 10,
  originPx: [320 * TILE_SIZE + 128, 575 * TILE_SIZE],
  width: 2432,
  height: 2560,
  scale: 1,
};

export const SATELLITE_GRID: GridSpec = {
  zoom: 11,
  originPx: [641 * TILE_SIZE, 1150 * TILE_SIZE],
  width: 19 * TILE_SIZE,
  height: 20 * TILE_SIZE,
  scale: 1,
};
