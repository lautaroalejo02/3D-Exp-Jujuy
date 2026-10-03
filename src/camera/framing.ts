import {
  elevationToWorldY,
  globalPixelToGrid,
  gridToGlobalPixel,
  gridToWorld,
  metersPerGridCell,
  type GridSpec,
} from "../geo";
import { OrbitCamera } from "./camera";

/**
 * A rectangle in canvas CSS px — used for the screen area the UI leaves
 * free (occluded by the mode bar + sheets on mobile, by the left panel
 * on desktop).
 */
export interface ViewRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The projection parameters that make framed content land inside a free
 * screen rectangle instead of the full viewport:
 *
 * - `offsetX`/`offsetY` are the camera's NDC view offset — the principal
 *   point moves to the free rect's center, so the orbit target projects
 *   there.
 * - `tanX`/`tanY` are the |tan| of the half-angles the free rect spans
 *   around that center. Fitting content to `|tanθ| <= tanX/tanY` keeps it
 *   inside the free rect even though the projection covers the full
 *   viewport.
 * - `aspect` is the free rect's own aspect, for choosing the framing
 *   direction (portrait vs landscape look).
 */
export interface ViewFit {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly tanX: number;
  readonly tanY: number;
  readonly aspect: number;
}

/**
 * Derive the ViewFit of `free` inside a `viewport` (same CSS-px space)
 * for a camera with vertical `fovDeg`. The free rect is clamped to the
 * viewport and to a 1 px minimum — a fully occluded viewport degenerates
 * to a near-centered pinhole instead of NaN.
 *
 * The math: NDC spans [-1, 1] over the viewport, so the free rect's
 * center sits at NDC (2cx/w - 1, 1 - 2cy/h) and its half-size is
 * (fw/w, fh/h) in NDC units. A view-space point projects to
 * ndc = (tanθx * aspect / f, tanθy * f)... so the |tanθ| limits that keep
 * content inside the free rect scale the nominal half-FOV tangents by
 * fh/h and fw/h.
 */
export function freeRectViewFit(
  viewport: { readonly width: number; readonly height: number },
  free: ViewRect,
  fovDeg: number,
): ViewFit {
  const w = Math.max(1, viewport.width);
  const h = Math.max(1, viewport.height);
  const x0 = Math.min(w, Math.max(0, free.x));
  const y0 = Math.min(h, Math.max(0, free.y));
  const x1 = Math.min(w, Math.max(0, free.x + free.width));
  const y1 = Math.min(h, Math.max(0, free.y + free.height));
  const fw = Math.max(1, x1 - x0);
  const fh = Math.max(1, y1 - y0);
  const cx = x0 + fw / 2;
  const cy = y0 + fh / 2;
  const tanHalfY = Math.tan((fovDeg * Math.PI) / 360);
  return {
    offsetX: (2 * cx - w) / w,
    offsetY: (h - 2 * cy) / h,
    tanX: (tanHalfY * fw) / h,
    tanY: (tanHalfY * fh) / h,
    aspect: fw / fh,
  };
}

/** A sub-region of the grid to frame instead of the whole mosaic. */
export interface FrameRegion {
  /**
   * Inclusive cell bounds [minI, minJ, maxI, maxJ] on `spec` — the
   * provinceBBoxGrid that terrain.json records for the province mask,
   * re-expressed on the height grid with bboxOnGrid when they differ.
   */
  readonly bboxGrid: readonly [number, number, number, number];
}

/**
 * Re-express inclusive cell bounds from a grid covering the same ground
 * extent (e.g. the departments raster's grid) on `spec`. Identity when the
 * grids coincide; still correct when one is a downsample of the other.
 */
export function bboxOnGrid(
  spec: GridSpec,
  from: GridSpec,
  bbox: readonly [number, number, number, number],
): readonly [number, number, number, number] {
  // Cell bounds cover borders: the min cells start at i-0.5 and the max
  // cells end at i+0.5. Convert both border positions to `spec` coords and
  // take the covering cells — when a border lands mid-cell (grids at
  // different resolutions), the inclusive bound still encloses the region.
  const [w, n] = gridToGlobalPixel(from, bbox[0] - 0.5, bbox[1] - 0.5);
  const [e, s] = gridToGlobalPixel(from, bbox[2] + 0.5, bbox[3] + 0.5);
  const [i0, j0] = globalPixelToGrid(spec, w, n);
  const [i1, j1] = globalPixelToGrid(spec, e, s);
  return [
    Math.floor(i0 + 0.5),
    Math.floor(j0 + 0.5),
    Math.ceil(i1 - 0.5),
    Math.ceil(j1 - 0.5),
  ];
}

/**
 * Initial view: a region of the grid (or the whole grid when no region is
 * given) fully visible. Nothing here is hand-picked: the target is the
 * region's center on the ground plane raised by half the exaggerated
 * relief, and the distance is derived so the region's projected footprint
 * plus the relief fit BOTH FOV axes — the across-view extent must fit the
 * horizontal FOV and the view-depth extent (foreshortened by the
 * elevation) plus the relief must fit the vertical FOV.
 *
 * Default view direction depends on the aspect: in landscape the camera
 * sits south-east (azimuth 45°, elevation 45°) for an oblique 3D read; in
 * portrait it sits due south looking north (azimuth 0°) at a lower 40°
 * elevation, so the province — taller than wide — spends its long axis
 * along the tall axis of the screen and the relief reads in 3D from the
 * start.
 */
export function overviewCamera(
  spec: GridSpec,
  aspect: number,
  relief: {
    /** Highest elevation of the loaded heightfield (from the DEM), meters. */
    readonly maxElevationMeters: number;
    readonly verticalExaggeration: number;
  },
  options: {
    readonly fovDeg?: number;
    readonly margin?: number;
    readonly azimuthDeg?: number;
    readonly elevationDeg?: number;
    readonly region?: FrameRegion;
    /**
     * Fit the region to a sub-rectangle of the viewport instead of the
     * whole frame: `tanX`/`tanY` are the usable half-FOV tangents and
     * `aspect` the free rect's aspect (it picks the portrait/landscape
     * view direction). The caller applies the matching view offset on
     * the returned camera so the target lands on the rect's center.
     */
    readonly fit?: Pick<ViewFit, "tanX" | "tanY" | "aspect">;
  } = {},
): OrbitCamera {
  const fovDeg = options.fovDeg ?? 45;
  const margin = options.margin ?? 1.1;
  const portrait = (options.fit?.aspect ?? aspect) < 1;
  const azimuthDeg = options.azimuthDeg ?? (portrait ? 0 : 45);
  const elevationDeg = options.elevationDeg ?? (portrait ? 40 : 45);
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;

  // Vertical allowance for the exaggerated relief, in world km. The target
  // sits at half that height so peaks and valleys share the slack evenly.
  const reliefKm = elevationToWorldY(
    relief.maxElevationMeters,
    relief.verticalExaggeration,
  );

  const bbox = options.region?.bboxGrid ?? [
    0,
    0,
    spec.width - 1,
    spec.height - 1,
  ];
  const cellKm = metersPerGridCell(spec) / 1000;
  // Inclusive cell bounds: the framed extent runs from the west/north
  // border of the min cells to the east/south border of the max cells.
  const halfX = ((bbox[2] - bbox[0] + 1) * cellKm) / 2;
  const halfZ = ((bbox[3] - bbox[1] + 1) * cellKm) / 2;
  const [targetX, , targetZ] = gridToWorld(
    spec,
    (bbox[0] + bbox[2]) / 2,
    (bbox[1] + bbox[3]) / 2,
  );

  // The exact fit has to account for perspective: a ground corner on the
  // camera's side of the region sits `cos(el) * along` km nearer than the
  // target distance and is magnified accordingly. Every term is linear or
  // |linear| over the (ground-offset, height) box, so the max is at one of
  // the 8 box corners — checking them all is exact.
  const halfFovY = (fovDeg * Math.PI) / 360;
  const tanX =
    options.fit?.tanX ??
    Math.tan(Math.atan(Math.tan(halfFovY) * aspect));
  const tanY = options.fit?.tanY ?? Math.tan(halfFovY);
  const sinAz = Math.sin(az);
  const cosAz = Math.cos(az);
  const sinEl = Math.sin(el);
  const cosEl = Math.cos(el);
  const halfRelief = reliefKm / 2;
  let distanceKm = 0;
  for (const dx of [-halfX, halfX]) {
    for (const dz of [-halfZ, halfZ]) {
      for (const dh of [-halfRelief, halfRelief]) {
        // along > 0 on the camera's side of the region; across is the
        // horizontal extent in view space. dh is height above the target.
        const along = sinAz * dx + cosAz * dz;
        const across = cosAz * dx - sinAz * dz;
        const yView = -sinEl * along + cosEl * dh;
        const depthOff = sinEl * dh + cosEl * along;
        distanceKm = Math.max(
          distanceKm,
          depthOff + Math.abs(across) / tanX,
          depthOff + Math.abs(yView) / tanY,
        );
      }
    }
  }
  distanceKm *= margin;

  return new OrbitCamera({
    target: [targetX, reliefKm / 2, targetZ],
    distanceKm,
    azimuthDeg,
    elevationDeg,
    fovDeg,
    aspect,
    nearKm: 0.5,
    minDistanceKm: 10,
    maxDistanceKm: Math.max(1500, distanceKm * 1.5),
  });
}
