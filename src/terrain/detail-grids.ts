/**
 * Pure tile-range → GridSpec math for the detail-patch pipeline
 * (scripts/build-detail.ts). A site downloads a block of satellite tiles at
 * one zoom and a smaller block of Terrarium DEM tiles at a coarser zoom;
 * this module derives the GridSpecs the rest of the system consumes and
 * the window to crop out of the DEM mosaic so it covers exactly the
 * satellite extent.
 *
 * All conversions happen in global pixel space (src/geo/slippy): px counts
 * scale by 2^(zoomA - zoomB) between integer zooms, and tile sizes are
 * multiples of 256, so every derived origin/size stays exact.
 */
import type { GridSpec } from "../geo/grid";
import { metersPerGridCell } from "../geo/world";
import { TILE_SIZE } from "../geo/slippy";
import { boxDownsample } from "./raster";
import { reconstructionError } from "./stats";

/** Inclusive tile index ranges for one tile source, from sources.json. */
export interface DetailTileRange {
  readonly zoom: number;
  readonly x: readonly [number, number];
  readonly y: readonly [number, number];
}

/** Crop window inside the DEM mosaic that matches the satellite extent. */
export interface DemCropWindow {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DetailSiteGrids {
  /** Satellite mosaic: one cell per source pixel (z14 for the patches). */
  readonly satelliteGrid: GridSpec;
  /**
   * DEM heights cropped to the satellite extent, expressed at the DEM
   * zoom — one cell per z12 pixel covering the same ground as
   * satelliteGrid.
   */
  readonly heightsGrid: GridSpec;
  /** The whole DEM tile block before cropping. */
  readonly demMosaicGrid: GridSpec;
  /** Window inside demMosaicGrid to crop (matches the satellite extent). */
  readonly demCrop: DemCropWindow;
  readonly satelliteTilesX: number;
  readonly satelliteTilesY: number;
  readonly demTilesX: number;
  readonly demTilesY: number;
}

function assertRange(range: DetailTileRange, what: string): void {
  const [x0, x1] = range.x;
  const [y0, y1] = range.y;
  const ints = [range.zoom, x0, x1, y0, y1].every(Number.isInteger);
  if (!ints || range.zoom < 0 || x0 < 0 || y0 < 0 || x1 < x0 || y1 < y0) {
    throw new Error(
      `${what}: invalid tile range zoom=${range.zoom} ` +
        `x=[${x0}, ${x1}] y=[${y0}, ${y1}]`,
    );
  }
}

/**
 * Grid specs for one detail site. The satellite extent (expressed at the
 * DEM zoom) must fit inside the DEM tile block — the download plan chooses
 * blocks that cover it; a violation here means sources.json is wrong, so
 * the build fails loudly instead of producing a misaligned patch.
 */
export function detailSiteGrids(
  siteId: string,
  satellite: DetailTileRange,
  dem: DetailTileRange,
): DetailSiteGrids {
  assertRange(satellite, `site ${siteId} satellite`);
  assertRange(dem, `site ${siteId} dem`);

  const satTilesX = satellite.x[1] - satellite.x[0] + 1;
  const satTilesY = satellite.y[1] - satellite.y[0] + 1;
  const demTilesX = dem.x[1] - dem.x[0] + 1;
  const demTilesY = dem.y[1] - dem.y[0] + 1;

  const zoomFactor = 2 ** (satellite.zoom - dem.zoom);
  if (!Number.isInteger(zoomFactor) || zoomFactor < 1) {
    throw new Error(
      `site ${siteId}: satellite zoom ${satellite.zoom} is not above ` +
        `dem zoom ${dem.zoom}`,
    );
  }
  if (TILE_SIZE % zoomFactor !== 0) {
    throw new Error(
      `site ${siteId}: tile size ${TILE_SIZE} is not divisible by the ` +
        `zoom factor ${zoomFactor}`,
    );
  }

  const satelliteGrid: GridSpec = {
    zoom: satellite.zoom,
    originPx: [satellite.x[0] * TILE_SIZE, satellite.y[0] * TILE_SIZE],
    width: satTilesX * TILE_SIZE,
    height: satTilesY * TILE_SIZE,
    scale: 1,
  };
  const demMosaicGrid: GridSpec = {
    zoom: dem.zoom,
    originPx: [dem.x[0] * TILE_SIZE, dem.y[0] * TILE_SIZE],
    width: demTilesX * TILE_SIZE,
    height: demTilesY * TILE_SIZE,
    scale: 1,
  };
  // The satellite extent re-expressed at the DEM zoom: exact integers
  // because tile boundaries are multiples of 256 px.
  const heightsGrid: GridSpec = {
    zoom: dem.zoom,
    originPx: [
      satelliteGrid.originPx[0] / zoomFactor,
      satelliteGrid.originPx[1] / zoomFactor,
    ],
    width: satelliteGrid.width / zoomFactor,
    height: satelliteGrid.height / zoomFactor,
    scale: 1,
  };
  const demCrop: DemCropWindow = {
    x: heightsGrid.originPx[0] - demMosaicGrid.originPx[0],
    y: heightsGrid.originPx[1] - demMosaicGrid.originPx[1],
    width: heightsGrid.width,
    height: heightsGrid.height,
  };
  if (
    demCrop.x < 0 ||
    demCrop.y < 0 ||
    demCrop.x + demCrop.width > demMosaicGrid.width ||
    demCrop.y + demCrop.height > demMosaicGrid.height
  ) {
    throw new Error(
      `site ${siteId}: satellite extent (z${dem.zoom} px ` +
        `[${heightsGrid.originPx[0]}, ${heightsGrid.originPx[1]}, ` +
        `${heightsGrid.originPx[0] + heightsGrid.width}, ` +
        `${heightsGrid.originPx[1] + heightsGrid.height}]) is not fully ` +
        `covered by the DEM block ` +
        `[${demMosaicGrid.originPx[0]}, ${demMosaicGrid.originPx[1]}, ` +
        `${demMosaicGrid.originPx[0] + demMosaicGrid.width}, ` +
        `${demMosaicGrid.originPx[1] + demMosaicGrid.height}]`,
    );
  }
  return {
    satelliteGrid,
    heightsGrid,
    demMosaicGrid,
    demCrop,
    satelliteTilesX: satTilesX,
    satelliteTilesY: satTilesY,
    demTilesX,
    demTilesY,
  };
}

/** Ground size of a patch in kilometers: [east, south]. */
export function detailSiteSizeKm(grid: GridSpec): readonly [number, number] {
  const cellKm = metersPerGridCell(grid) / 1000;
  return [cellKm * grid.width, cellKm * grid.height];
}

/**
 * Downsampling factor for the lift estimate: 8 coarsens the z12 patch
 * heights to ~280 m cells, matching the base terrain's default level
 * (heights-half). The `alta` level (~140 m cells, factor 4) is covered
 * too — its reconstruction error is a subset of the coarser one.
 */
export const LIFT_ESTIMATE_FACTOR = 8;

/**
 * Elevation lift (meters, before exaggeration) so the patch surface stays
 * above the coincident base terrain everywhere in its extent.
 *
 * Estimated without reading the base data: downsample the patch heights by
 * LIFT_ESTIMATE_FACTOR, reconstruct them bilinearly, and take the worst
 * absolute error — that is how far a base-resolution surface can sit above
 * or below the patch.
 */
export function detailLiftMeters(
  heights: Float32Array,
  width: number,
  height: number,
  factor = LIFT_ESTIMATE_FACTOR,
): { readonly maxDiffMeters: number; readonly liftMeters: number } {
  const coarse = boxDownsample(heights, width, height, factor);
  const error = reconstructionError(
    heights,
    width,
    height,
    coarse.data,
    coarse.width,
    coarse.height,
    factor,
  );
  return {
    maxDiffMeters: error.maxAbsErrorMeters,
    // The *1.2 and +25 m are a RENDERING margin, not terrain data: they
    // absorb the difference between the real base DEM (z10 Terrarium
    // pyramid) and this self-downsample estimate so the patch always wins
    // the depth test. Task D2 revisits this — the plan is to drop the
    // uniform lift once the base terrain is masked inside the patch.
    liftMeters: Math.ceil(error.maxAbsErrorMeters * 1.2 + 25),
  };
}
