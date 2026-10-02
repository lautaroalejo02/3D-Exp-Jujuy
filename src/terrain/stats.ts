import { bilinearSample } from "./raster";
import type { ElevationStats, ReconstructionError } from "./manifest";

const round2 = (v: number): number => Math.round(v * 100) / 100;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const round4 = (v: number): number => Math.round(v * 10000) / 10000;

/**
 * Rank-q percentile with linear interpolation between closest ranks
 * (numpy "linear" / type 7): r = q * (n - 1). `sorted` must be
 * non-empty and already sorted ascending.
 */
function sortedPercentile(sorted: ArrayLike<number>, q: number): number {
  const rank = q * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? 0;
  return a + (b - a) * (rank - lo);
}

/** Percentile of `values` (copied and sorted internally). q in [0, 1]. */
export function percentile(values: ArrayLike<number>, q: number): number {
  if (values.length === 0) throw new Error("percentile: empty input");
  if (q < 0 || q > 1) {
    throw new Error(`percentile: q must be in [0, 1], got ${q}`);
  }
  return sortedPercentile(Float64Array.from(values).sort(), q);
}

/** Min, max, mean and the 0.1%/99.9% percentiles of a height grid. */
export function elevationStats(heights: ArrayLike<number>): ElevationStats {
  if (heights.length === 0) throw new Error("elevationStats: empty input");
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let k = 0; k < heights.length; k++) {
    const h = heights[k] ?? 0;
    if (h < min) min = h;
    if (h > max) max = h;
    sum += h;
  }
  const sorted = Float64Array.from(heights).sort();
  return {
    minMeters: round2(min),
    maxMeters: round2(max),
    meanMeters: round2(sum / heights.length),
    p001Meters: round2(sortedPercentile(sorted, 0.001)),
    p999Meters: round2(sortedPercentile(sorted, 0.999)),
  };
}

/**
 * Error of reconstructing the full-res grid from a `factor`-downsampled
 * grid: for every full-res cell, |full height - bilinear sample of the
 * coarse grid| at the cell's center.
 *
 * The coarse sample (i, j) sits at the center of full-res pixels
 * [i*f, i*f+f), so the full cell center i+0.5 maps to the coarse-grid
 * coordinate (i+0.5)/f - 0.5; bilinearSample clamps at the borders.
 */
export function reconstructionError(
  full: ArrayLike<number>,
  fullWidth: number,
  fullHeight: number,
  half: ArrayLike<number>,
  halfWidth: number,
  halfHeight: number,
  factor: number,
): ReconstructionError {
  if (full.length !== fullWidth * fullHeight) {
    throw new Error(
      `reconstructionError: full length ${full.length} != ${fullWidth}x${fullHeight}`,
    );
  }
  if (half.length !== halfWidth * halfHeight) {
    throw new Error(
      `reconstructionError: half length ${half.length} != ${halfWidth}x${halfHeight}`,
    );
  }
  const errors = new Float64Array(full.length);
  let sum = 0;
  let over20 = 0;
  for (let j = 0; j < fullHeight; j++) {
    const hj = (j + 0.5) / factor - 0.5;
    for (let i = 0; i < fullWidth; i++) {
      const hi = (i + 0.5) / factor - 0.5;
      const e = Math.abs(
        (full[j * fullWidth + i] ?? 0) -
          bilinearSample(half, halfWidth, halfHeight, hi, hj),
      );
      errors[j * fullWidth + i] = e;
      sum += e;
      if (e > 20) over20++;
    }
  }
  return {
    maxAbsErrorMeters: round3(errors.reduce((m, e) => Math.max(m, e), 0)),
    meanAbsErrorMeters: round3(sum / errors.length),
    p99AbsErrorMeters: round3(sortedPercentile(errors.sort(), 0.99)),
    fractionOver20Meters: round4(over20 / errors.length),
  };
}
