import type { ProfilePoint, ProfileStats } from "./profile";

/**
 * Pure geometry of the profile chart: distances and elevations mapped
 * into a fixed-size SVG viewBox, round-number axis ticks and the paths
 * of the curve and the filled area under it. No DOM — the DOM component
 * in perfil-mode.ts renders what this returns, and tests check the math.
 */

/** Inner plot area inside the chart's viewBox, in px. */
export const CHART_MARGIN = {
  left: 46,
  right: 12,
  top: 14,
  bottom: 22,
} as const;

/** Chart height in the sheet (the width is measured from the DOM). */
export const CHART_HEIGHT_PX = 168;

export interface ChartTick {
  /** Axis value: km on x, meters on y. */
  readonly value: number;
  /** Position inside the viewBox, px. */
  readonly pos: number;
}

export interface ChartExtremum {
  readonly x: number;
  readonly y: number;
  readonly elevationMeters: number;
  readonly distanceMeters: number;
}

export interface ChartModel {
  /** SVG path of the profile curve (M/L segments; gaps break it). */
  readonly linePath: string;
  /** Filled area under the curve, closed down to the plot baseline. */
  readonly areaPath: string;
  /** Distance ticks along the bottom edge, values in km. */
  readonly xTicks: readonly ChartTick[];
  /** Elevation ticks along the left edge, values in meters. */
  readonly yTicks: readonly ChartTick[];
  /** Screen position of the profile's min / max for the labels. */
  readonly minPoint: ChartExtremum | undefined;
  readonly maxPoint: ChartExtremum | undefined;
  readonly plot: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** Map a transect distance (meters) to a viewBox x. */
  xFor(distanceMeters: number): number;
  /** Map an elevation (meters) to a viewBox y. */
  yFor(elevationMeters: number): number;
  /** Inverse of xFor: viewBox x -> transect distance (clamped). */
  distanceFor(xPx: number): number;
  /** Bottom edge of the plot (the area baseline). */
  readonly baselineY: number;
}

const NICE_STEPS = [1, 2, 5, 10] as const;

/**
 * Round-number ticks covering [min, max]: the largest 1/2/5 step that is
 * no bigger than span/targetCount, so the count ends near the target.
 */
export function niceTicks(
  min: number,
  max: number,
  targetCount: number,
): number[] {
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) return [min];
  const raw = span / Math.max(1, targetCount);
  const mag = 10 ** Math.floor(Math.log10(raw));
  let step = mag;
  for (const mult of NICE_STEPS) {
    if (mult * mag <= raw) step = mult * mag;
  }
  const first = Math.ceil(min / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = first; v <= max + 1e-9; v += step) {
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    if (ticks.length > 1000) break; // pathological span guard
  }
  return ticks;
}

const fmtNum = (v: number): string => {
  // 0.1-px rounding keeps the path strings short and the file small.
  const r = Math.round(v * 10) / 10;
  return Object.is(r, -0) ? "0" : String(r);
};

/**
 * The full chart layout for a transect, for an SVG `viewBox` of
 * `widthPx` x `heightPx`. The y range is padded ~4% past [min, max] so
 * the extremum labels fit; a flat profile still gets a nonzero range.
 */
export function chartModel(
  samples: readonly ProfilePoint[],
  stats: ProfileStats,
  widthPx: number,
  heightPx: number,
): ChartModel {
  const plot = {
    x: CHART_MARGIN.left,
    y: CHART_MARGIN.top,
    width: Math.max(10, widthPx - CHART_MARGIN.left - CHART_MARGIN.right),
    height: Math.max(10, heightPx - CHART_MARGIN.top - CHART_MARGIN.bottom),
  };
  const totalMeters = Math.max(stats.distanceMeters, 1);
  const pad = stats.rangeMeters > 0 ? stats.rangeMeters * 0.04 : 10;
  const yMin = stats.minMeters - pad;
  const yMax = stats.maxMeters + pad;
  const baselineY = plot.y + plot.height;

  const xFor = (distanceMeters: number): number =>
    plot.x + (distanceMeters / totalMeters) * plot.width;
  const yFor = (elevationMeters: number): number =>
    plot.y + (1 - (elevationMeters - yMin) / (yMax - yMin)) * plot.height;
  const distanceFor = (xPx: number): number =>
    Math.min(
      totalMeters,
      Math.max(0, ((xPx - plot.x) / plot.width) * totalMeters),
    );

  // Path building: off-grid samples break the curve into M-subpaths;
  // the area repeats the same runs and closes each down to the baseline.
  const line: string[] = [];
  const area: string[] = [];
  let runStart: { x: number; y: number } | undefined;
  let runEnd: { x: number; y: number } | undefined;
  const closeRun = (): void => {
    if (runStart === undefined || runEnd === undefined) return;
    area.push(
      `L${fmtNum(runEnd.x)},${fmtNum(baselineY)}`,
      `L${fmtNum(runStart.x)},${fmtNum(baselineY)}`,
      "Z",
    );
    runStart = undefined;
    runEnd = undefined;
  };
  for (const s of samples) {
    if (s.elevationMeters === undefined) {
      closeRun();
      continue;
    }
    const x = xFor(s.distanceMeters);
    const y = yFor(s.elevationMeters);
    if (runStart === undefined) {
      line.push(`M${fmtNum(x)},${fmtNum(y)}`);
      area.push(`M${fmtNum(x)},${fmtNum(baselineY)}`, `L${fmtNum(x)},${fmtNum(y)}`);
      runStart = { x, y };
    } else {
      line.push(`L${fmtNum(x)},${fmtNum(y)}`);
      area.push(`L${fmtNum(x)},${fmtNum(y)}`);
    }
    runEnd = { x, y };
  }
  closeRun();

  const extremum = (index: number): ChartExtremum | undefined => {
    const s = samples[index];
    if (s === undefined || s.elevationMeters === undefined) return undefined;
    return {
      x: xFor(s.distanceMeters),
      y: yFor(s.elevationMeters),
      elevationMeters: s.elevationMeters,
      distanceMeters: s.distanceMeters,
    };
  };

  return {
    linePath: line.join(""),
    areaPath: area.join(""),
    xTicks: niceTicks(0, totalMeters / 1000, Math.max(2, plot.width / 90)).map(
      (km) => ({ value: km, pos: xFor(km * 1000) }),
    ),
    yTicks: niceTicks(yMin, yMax, 3).map((m) => ({ value: m, pos: yFor(m) })),
    minPoint: extremum(stats.minIndex),
    maxPoint: extremum(stats.maxIndex),
    plot,
    xFor,
    yFor,
    distanceFor,
    baselineY,
  };
}
