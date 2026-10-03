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
 * Maximum number of detail patches the base terrain can mask at once:
 * the size of the `patchRects` uniform array in terrain.wgsl.
 */
export const MAX_DETAIL_PATCHES = 8;

/**
 * Linear map between a patch's height-grid coords and the base grid's.
 * Both grids share global-pixel space (px counts scale by
 * 2^(patchZoom - baseZoom)), so the mapping is axis-aligned and exact:
 *   baseGridI = (patchGridI + 0.5) * k[0] + c[0]
 *   baseGridJ = (patchGridJ + 0.5) * k[1] + c[1]
 * Used by the detail shader (geomorph target), the base shader's discard
 * rect and picking — all three must agree on the same conversion.
 */
export interface PatchBaseGridMap {
  readonly k: readonly [number, number];
  readonly c: readonly [number, number];
}

export function patchBaseGridMap(
  patchSpec: GridSpec,
  baseSpec: GridSpec,
): PatchBaseGridMap {
  const zoomFactor = 2 ** (patchSpec.zoom - baseSpec.zoom);
  const k = patchSpec.scale / (zoomFactor * baseSpec.scale);
  return {
    k: [k, k],
    c: [
      (patchSpec.originPx[0] - zoomFactor * baseSpec.originPx[0]) /
        (zoomFactor * baseSpec.scale) -
        0.5,
      (patchSpec.originPx[1] - zoomFactor * baseSpec.originPx[1]) /
        (zoomFactor * baseSpec.scale) -
        0.5,
    ],
  };
}

/** Patch grid coords -> base grid coords. */
export function patchGridToBaseGrid(
  map: PatchBaseGridMap,
  gi: number,
  gj: number,
): readonly [number, number] {
  return [
    (gi + 0.5) * map.k[0] + map.c[0],
    (gj + 0.5) * map.k[1] + map.c[1],
  ];
}

/** Base grid coords -> patch grid coords (inverse of patchGridToBaseGrid). */
export function baseGridToPatchGrid(
  map: PatchBaseGridMap,
  bi: number,
  bj: number,
): readonly [number, number] {
  return [
    (bi - map.c[0]) / map.k[0] - 0.5,
    (bj - map.c[1]) / map.k[1] - 0.5,
  ];
}

/**
 * One patch's discard rect for the base terrain shader: the patch's FULL
 * outer extent re-expressed in base grid coords — the whole patch, not
 * just its opaque interior. When the patch is drawn the base discards
 * every fragment inside this rect and the patch geomorphs onto the base
 * surface at the border, so no part of the coarser base can poke through.
 */
export interface DetailPatchRect {
  /** Site id; the terrain layer toggles the rect's active flag by name. */
  readonly id: string;
  /** Bounds [i0, j0, i1, j1] in base grid coords (i0 < i1, j0 < j1). */
  readonly rect: readonly [number, number, number, number];
}

/**
 * Full outer extent of a patch in base grid coords: patch grid coords
 * span [-0.5, width-0.5] x [-0.5, height-0.5], so converting the two
 * opposite corners gives the rect.
 */
export function detailPatchRectBaseGrid(
  patchSpec: GridSpec,
  baseSpec: GridSpec,
): readonly [number, number, number, number] {
  const map = patchBaseGridMap(patchSpec, baseSpec);
  const [i0, j0] = patchGridToBaseGrid(map, -0.5, -0.5);
  const [i1, j1] = patchGridToBaseGrid(
    map,
    patchSpec.width - 0.5,
    patchSpec.height - 0.5,
  );
  return [i0, j0, i1, j1];
}

/**
 * Discard rects for every site, in the same order. Capped at
 * MAX_DETAIL_PATCHES (the shader's uniform array size): extra sites keep
 * rendering over the base — degraded, not broken — so the overflow is a
 * warning, not a failure.
 */
export function buildDetailPatchRects(
  sites: readonly { readonly id: string; readonly spec: GridSpec }[],
  baseSpec: GridSpec,
): DetailPatchRect[] {
  if (sites.length > MAX_DETAIL_PATCHES) {
    console.warn(
      `detail patches: ${sites.length} sites exceed the ` +
        `${MAX_DETAIL_PATCHES}-rect shader limit; only the first ` +
        `${MAX_DETAIL_PATCHES} get a base-terrain mask`,
    );
  }
  return sites.slice(0, MAX_DETAIL_PATCHES).map((s) => ({
    id: s.id,
    rect: detailPatchRectBaseGrid(s.spec, baseSpec),
  }));
}
