import { gridContains, lonLatToGrid, type GridSpec } from "../../geo/grid";
import { metersPerGridCell } from "../../geo/world";
import type { Heightfield } from "../../terrain/heightfield";

/**
 * Pure math for the Perfil mode: sampling a transect across the DEM and
 * reducing it to the educational stats shown in the sheet (distance,
 * max/min, desnivel, total ascent and descent). No DOM, no GPU — the same
 * functions feed the chart, the draped map line and the headless
 * snapshot's stamped line.
 *
 * Points are kept in fractional base-grid coordinates (i, j) plus the
 * cumulative GROUND distance in meters that Heightfield.sampleAlong
 * computes (Mercator steps corrected per latitude). The elevation comes
 * from whichever surface sampler the caller injects — the app passes the
 * drawn surface (base DEM + the geomorphed detail patches currently
 * covering), the snapshot passes the plain bilinear sample.
 */

/** One sampled point of the transect, in base grid coords. */
export interface ProfilePoint {
  readonly i: number;
  readonly j: number;
  /** Cumulative ground distance from point A, meters. */
  readonly distanceMeters: number;
  /** Surface height; undefined off the grid. */
  readonly elevationMeters: number | undefined;
}

/** Sampling density bounds: ~2 samples per grid cell, clamped. */
export const PROFILE_MIN_SAMPLES = 96;
export const PROFILE_MAX_SAMPLES = 2048;

/**
 * How many samples a transect needs: ~2 per grid cell so ridges narrower
 * than a cell are not skipped, clamped so a 10 m line still gets a usable
 * count and a province-length diagonal stays CPU-cheap.
 */
export function profileSampleCount(
  distanceMeters: number,
  cellSizeMeters: number,
): number {
  if (!(distanceMeters > 0) || !(cellSizeMeters > 0)) {
    return PROFILE_MIN_SAMPLES;
  }
  const n = Math.ceil(distanceMeters / (cellSizeMeters * 0.5)) + 1;
  return Math.min(
    PROFILE_MAX_SAMPLES,
    Math.max(PROFILE_MIN_SAMPLES, n),
  );
}

/**
 * Approximate ground distance between two lon/lat points on this grid —
 * grid distance times the meters-per-cell factor. Good enough for
 * choosing the sample count and the "points too close" guard; the exact
 * cumulative distance comes out of sampleAlong.
 */
export function profileGroundDistanceMeters(
  spec: GridSpec,
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const [ai, aj] = lonLatToGrid(spec, a[0], a[1]);
  const [bi, bj] = lonLatToGrid(spec, b[0], b[1]);
  return Math.hypot(bi - ai, bj - aj) * metersPerGridCell(spec);
}

export interface BuildProfileOptions {
  /** Override the auto sample count (tests). */
  readonly samples?: number;
  /**
   * Surface sampler in meters at base grid coords. Default: the DEM's
   * bilinear sample. The app passes the drawn surface so the profile
   * includes the detail patches the line crosses.
   */
  readonly elevationAt?: (i: number, j: number) => number;
}

/**
 * The transect samples between lon/lat A and B: Heightfield.sampleAlong
 * does the Mercator walk and the ground-distance accumulation; this only
 * re-expresses each sample in base grid coords and attaches the surface
 * elevation from the injected sampler.
 */
export function buildProfileSamples(
  heightfield: Heightfield,
  a: readonly [number, number],
  b: readonly [number, number],
  opts: BuildProfileOptions = {},
): ProfilePoint[] {
  const spec = heightfield.spec;
  const n =
    opts.samples ??
    profileSampleCount(
      profileGroundDistanceMeters(spec, a, b),
      metersPerGridCell(spec),
    );
  const elevationAt = opts.elevationAt ?? ((i: number, j: number) =>
    heightfield.heightAtGrid(i, j));
  return heightfield.sampleAlong(a, b, n).map((s) => {
    const [i, j] = lonLatToGrid(spec, s.lon, s.lat);
    return {
      i,
      j,
      distanceMeters: s.distanceMeters,
      elevationMeters: gridContains(spec, i, j)
        ? elevationAt(i, j)
        : undefined,
    };
  });
}

/** The stats row the sheet shows next to the chart. */
export interface ProfileStats {
  /** Total ground distance of the transect, meters. */
  readonly distanceMeters: number;
  readonly minMeters: number;
  readonly maxMeters: number;
  /** max - min. */
  readonly rangeMeters: number;
  /** Sum of all uphill steps, meters. */
  readonly ascentMeters: number;
  /** Sum of all downhill steps, meters. */
  readonly descentMeters: number;
  /** Index of the min / max sample (first occurrence on ties). */
  readonly minIndex: number;
  readonly maxIndex: number;
  readonly definedCount: number;
}

/**
 * Reduces a sampled transect to its stats. Off-grid samples keep the
 * walk going (their distance counts) but contribute no elevation: the
 * ascent/descent between the two defined samples bracketing a gap counts
 * as one step. Undefined when fewer than two samples have an elevation.
 */
/** Minimum elevation change (m) counted toward total ascent/descent. */
export const ASCENT_THRESHOLD_METERS = 25;

export function computeProfileStats(
  samples: readonly ProfilePoint[],
): ProfileStats | undefined {
  let definedCount = 0;
  let minMeters = Infinity;
  let maxMeters = -Infinity;
  let minIndex = -1;
  let maxIndex = -1;
  let ascentMeters = 0;
  let descentMeters = 0;
  let prevElevation: number | undefined;
  let distanceMeters = 0;
  for (const [k, s] of samples.entries()) {
    distanceMeters = s.distanceMeters;
    const e = s.elevationMeters;
    if (e === undefined) continue;
    definedCount += 1;
    if (e < minMeters) {
      minMeters = e;
      minIndex = k;
    }
    if (e > maxMeters) {
      maxMeters = e;
      maxIndex = k;
    }
    // Hysteresis: DEM noise (tens of meters per sample over steep terrain)
    // would otherwise inflate the totals; only changes of at least
    // ASCENT_THRESHOLD_METERS from the last anchor count, as hiking GPS do.
    if (prevElevation === undefined) {
      prevElevation = e;
    } else {
      const d = e - prevElevation;
      if (d >= ASCENT_THRESHOLD_METERS) {
        ascentMeters += d;
        prevElevation = e;
      } else if (d <= -ASCENT_THRESHOLD_METERS) {
        descentMeters -= d;
        prevElevation = e;
      }
    }
  }
  if (definedCount < 2) return undefined;
  return {
    distanceMeters,
    minMeters,
    maxMeters,
    rangeMeters: maxMeters - minMeters,
    ascentMeters,
    descentMeters,
    minIndex,
    maxIndex,
    definedCount,
  };
}

/**
 * Point on the transect at ground distance `d`, interpolated between the
 * bracketing samples (i/j always interpolate; the elevation is undefined
 * when a bracketing sample is off the grid). Clamps to the ends.
 */
export function sampleAtDistance(
  samples: readonly ProfilePoint[],
  d: number,
): ProfilePoint {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first === undefined) {
    return { i: 0, j: 0, distanceMeters: 0, elevationMeters: undefined };
  }
  if (last === undefined || d <= first.distanceMeters) return first;
  if (d >= last.distanceMeters) return last;
  // Binary search: samples[lo].d <= d <= samples[lo+1].d.
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.distanceMeters <= d) lo = mid;
    else hi = mid;
  }
  const s0 = samples[lo]!;
  const s1 = samples[hi]!;
  const span = s1.distanceMeters - s0.distanceMeters;
  const t = span > 0 ? (d - s0.distanceMeters) / span : 0;
  const e0 = s0.elevationMeters;
  const e1 = s1.elevationMeters;
  return {
    i: s0.i + (s1.i - s0.i) * t,
    j: s0.j + (s1.j - s0.j) * t,
    distanceMeters: d,
    elevationMeters:
      e0 !== undefined && e1 !== undefined ? e0 + (e1 - e0) * t : undefined,
  };
}

export interface PolylineNearest {
  /** Fractional index into `points` (k + segment t). */
  readonly index: number;
  readonly x: number;
  readonly y: number;
  /** Screen distance from `target` to the polyline, px. */
  readonly distPx: number;
}

/**
 * Nearest point on a screen-space polyline to `target`, as a fractional
 * index — the caller maps it back to a distance along the transect. Used
 * by the "hover/tap near the line moves the chart cursor" gesture.
 */
export function nearestOnPolyline(
  points: readonly { readonly x: number; readonly y: number }[],
  target: { readonly x: number; readonly y: number },
): PolylineNearest | undefined {
  if (points.length === 0) return undefined;
  if (points.length === 1) {
    const p = points[0]!;
    return {
      index: 0,
      x: p.x,
      y: p.y,
      distPx: Math.hypot(target.x - p.x, target.y - p.y),
    };
  }
  let bestD2 = Infinity;
  let bestIndex = 0;
  let bestX = 0;
  let bestY = 0;
  for (let k = 0; k < points.length - 1; k++) {
    const a = points[k]!;
    const b = points[k + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t =
      len2 > 0
        ? Math.min(
            1,
            Math.max(
              0,
              ((target.x - a.x) * dx + (target.y - a.y) * dy) / len2,
            ),
          )
        : 0;
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    const d2 = (target.x - px) * (target.x - px) + (target.y - py) * (target.y - py);
    if (d2 < bestD2) {
      bestD2 = d2;
      bestIndex = k + t;
      bestX = px;
      bestY = py;
    }
  }
  return { index: bestIndex, x: bestX, y: bestY, distPx: Math.sqrt(bestD2) };
}

/**
 * Transect distance (meters) for a fractional sample index — the inverse
 * mapping of projecting the samples to the screen polyline, so a hover
 * near the line lands on the right chart distance.
 */
export function distanceAtFractionalIndex(
  samples: readonly ProfilePoint[],
  index: number,
): number {
  const k0 = Math.max(0, Math.floor(index));
  const k1 = Math.min(samples.length - 1, k0 + 1);
  const t = Math.min(1, Math.max(0, index - k0));
  const s0 = samples[k0];
  const s1 = samples[k1];
  if (s0 === undefined || s1 === undefined) return 0;
  return s0.distanceMeters + (s1.distanceMeters - s0.distanceMeters) * t;
}
