import { gridExtentGlobalPixels, type GridSpec } from "../geo/grid";

/**
 * The satellite image is textured over the height grid, so both grids must
 * cover the same ground. Matching pixel dimensions are not enough: a DEM
 * and a mosaic with different origins or zooms would still produce a
 * plausible-looking but geographically wrong render. This check compares
 * both GridSpec extents in a common global-pixel space.
 */

/** Half a pixel at the finer of the two zooms: float noise only. */
const EXTENT_TOLERANCE_PX = 0.5;

export class GridExtentMismatchError extends Error {
  constructor(
    readonly heightsExtent: readonly [number, number, number, number],
    readonly satelliteExtent: readonly [number, number, number, number],
    readonly zoom: number,
  ) {
    super(
      `height and satellite grids cover different extents ` +
        `(global px at z${zoom}): heights=[${heightsExtent.join(", ")}] ` +
        `satellite=[${satelliteExtent.join(", ")}]`,
    );
    this.name = "GridExtentMismatchError";
  }
}

/** Grid extent [left, top, right, bottom] re-expressed at `zoom`. */
function extentAtZoom(
  spec: GridSpec,
  zoom: number,
): readonly [number, number, number, number] {
  const factor = 2 ** (zoom - spec.zoom);
  const [left, top, right, bottom] = gridExtentGlobalPixels(spec);
  return [left * factor, top * factor, right * factor, bottom * factor];
}

/**
 * Throws GridExtentMismatchError unless both grids cover the same
 * geographic extent (left/top/right/bottom), regardless of their zooms.
 */
export function assertSameGroundExtent(
  heights: GridSpec,
  satellite: GridSpec,
): void {
  const zoom = Math.max(heights.zoom, satellite.zoom);
  const heightsExtent = extentAtZoom(heights, zoom);
  const satelliteExtent = extentAtZoom(satellite, zoom);
  for (let k = 0; k < 4; k++) {
    const a = heightsExtent[k] ?? 0;
    const b = satelliteExtent[k] ?? 0;
    if (Math.abs(a - b) > EXTENT_TOLERANCE_PX) {
      throw new GridExtentMismatchError(heightsExtent, satelliteExtent, zoom);
    }
  }
}
