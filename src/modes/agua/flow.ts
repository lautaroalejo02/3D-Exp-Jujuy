/**
 * Pure hydrology for the Agua mode: selective depression filling
 * (priority-flood, Barnes et al. 2014), D8 flow direction, upstream flow
 * accumulation and drainage-basin labeling. Everything here runs on plain
 * typed arrays over a row-major grid (j southward, i eastward, cell
 * centers at integer coords — the src/geo convention), so the build
 * script and the unit tests share the exact same code.
 *
 * Two kinds of cells end a flow path: grid-edge cells (water leaves the
 * model — routing the whole grid, not just the province, keeps the real
 * upstream of rivers ENTERING Jujuy) and the bottoms of large closed
 * depressions. The Puna is endorheic — Laguna de los Pozuelos, Laguna de
 * Guayatayoc and the salares do not drain to the sea — so only SMALL
 * depressions (DEM noise) are filled; bigger ones stay terminal sinks
 * (see findDepressions / routeElevations). Basin labels are restricted
 * to the province mask.
 */

/** Direction code for a cell with no downslope neighbor (edge sink). */
export const FLOW_DIR_NONE = 0;

/**
 * D8 direction codes, clockwise from east, matching D8_DI/D8_DJ:
 * 1=E 2=SE 3=S 4=SW 5=W 6=NW 7=N 8=NE. Index 0 is FLOW_DIR_NONE.
 */
export const D8_DI: readonly number[] = [0, 1, 1, 0, -1, -1, -1, 0, 1];
export const D8_DJ: readonly number[] = [0, 0, 1, 1, 1, 0, -1, -1, -1];

/** Basins raster value for cells outside the province mask. */
export const BASIN_OUTSIDE = 255;
/** Basins raster value for in-province cells not in a main basin. */
export const BASIN_OTHER = 0;
/** Main basins kept in the output (task: "keep the top ~6-10"). */
export const MAX_MAIN_BASINS = 8;

/** Elevation step the epsilon flood adds per cell across flat/pit areas. */
export const FLOOD_EPSILON = 0.01;

/**
 * Depression-fill thresholds (the "small pits" of the task): a ponded
 * component is FILLED — treated as DEM noise — only when it is small,
 * i.e. either its area is under FILL_AREA_CELLS cells or its depth under
 * FILL_DEPTH_METERS meters. A component that is at least as large AND at
 * least as deep is a real closed basin and stays a terminal sink.
 *
 * Calibration (flow grid: ~305 m/cell, ~0.09 km²/cell): DEM artifacts are
 * pits of a few cells and < ~2 m deep. The smallest real endorheic
 * feature we must keep (Laguna de los Pozuelos's basin) ponded ~500 cells
 * / ~40 km² and ~40 m deep in this DEM — several orders above the
 * thresholds, so the split is not sensitive to the exact values.
 */
export const FILL_AREA_CELLS = 64;
export const FILL_DEPTH_METERS = 3;

/**
 * Elevation tolerance (m) for the minimal flood's ponded mask: a cell
 * whose no-epsilon fill exceeds its raw height by more than this ponds
 * water — it cannot drain at its own elevation.
 */
export const PONDED_TOLERANCE_METERS = 0.01;

/**
 * Accumulation log encoding: the Uint16 raster stores
 * round(log2(acc) * ACC_LOG2_SCALE) — acc is the upstream cell count,
 * always >= 1, so the stored value is >= 0 and fits easily
 * (log2(1.56M cells) * 256 ≈ 5300 « 65535).
 */
export const ACC_LOG2_SCALE = 256;

export interface PriorityFloodResult {
  /**
   * Filled elevation per cell (meters): every non-edge cell is raised
   * just enough to drain toward an edge, with FLOOD_EPSILON steps across
   * flats so D8 has a strict downslope everywhere.
   */
  readonly filled: Float32Array;
  /**
   * Cells in flood pop order — nondecreasing filled elevation. The
   * accumulation pass consumes it in reverse (strictly downstream-first
   * is not needed; upstream cells always come AFTER their drain target).
   */
  readonly order: Uint32Array;
}

/**
 * Min-heap over (key, insertionSeq) pairs with a cell payload. Each grid
 * cell is pushed exactly once (cells are marked when enqueued, not when
 * popped), so capacity equals the cell count and no array ever grows.
 * Ties break on insertion order — the flood is fully deterministic.
 */
class FloodHeap {
  private readonly keys: Float64Array;
  private readonly seqs: Uint32Array;
  private readonly vals: Uint32Array;
  private count = 0;
  private seq = 0;

  constructor(capacity: number) {
    this.keys = new Float64Array(capacity);
    this.seqs = new Uint32Array(capacity);
    this.vals = new Uint32Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  push(key: number, val: number): void {
    let k = this.count++;
    this.keys[k] = key;
    this.seqs[k] = this.seq++;
    this.vals[k] = val;
    // Sift up.
    while (k > 0) {
      const parent = (k - 1) >> 1;
      if (this.before(k, parent)) {
        this.swap(k, parent);
        k = parent;
      } else {
        break;
      }
    }
  }

  pop(): number {
    const top = this.vals[0] ?? -1;
    this.count--;
    if (this.count > 0) {
      this.keys[0] = this.keys[this.count] ?? 0;
      this.seqs[0] = this.seqs[this.count] ?? 0;
      this.vals[0] = this.vals[this.count] ?? 0;
      // Sift down.
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let smallest = k;
        if (l < this.count && this.before(l, smallest)) smallest = l;
        if (r < this.count && this.before(r, smallest)) smallest = r;
        if (smallest === k) break;
        this.swap(k, smallest);
        k = smallest;
      }
    }
    return top;
  }

  /** True when heap slot a sorts strictly before slot b. */
  private before(a: number, b: number): boolean {
    const ka = this.keys[a] ?? 0;
    const kb = this.keys[b] ?? 0;
    if (ka !== kb) return ka < kb;
    return (this.seqs[a] ?? 0) < (this.seqs[b] ?? 0);
  }

  private swap(a: number, b: number): void {
    const k = this.keys[a] ?? 0;
    const s = this.seqs[a] ?? 0;
    const v = this.vals[a] ?? 0;
    this.keys[a] = this.keys[b] ?? 0;
    this.seqs[a] = this.seqs[b] ?? 0;
    this.vals[a] = this.vals[b] ?? 0;
    this.keys[b] = k;
    this.seqs[b] = s;
    this.vals[b] = v;
  }
}

/**
 * Priority-flood depression fill (Barnes, Lehman & Mulla 2014, "epsilon"
 * variant). Border cells are the sinks; every other cell is raised to
 * max(own height, lowest-path + epsilon) so flats keep a strict
 * downslope gradient toward the drain and closed pits fill to their
 * spill level. `epsilon` defaults to FLOOD_EPSILON; pass 0 for the
 * minimal fill — the variant findDepressions uses, where only truly
 * ponded cells come out above their raw height.
 */
export function priorityFloodFill(
  heights: ArrayLike<number>,
  width: number,
  height: number,
  epsilon = FLOOD_EPSILON,
): PriorityFloodResult {
  const n = width * height;
  if (heights.length !== n) {
    throw new Error(
      `priorityFloodFill: heights length ${heights.length} != ${width}x${height}`,
    );
  }
  const filled = new Float32Array(n);
  const closed = new Uint8Array(n);
  const order = new Uint32Array(n);
  const heap = new FloodHeap(n);

  // Seeds: the whole outer ring drains to itself at its own elevation.
  for (let i = 0; i < width; i++) {
    for (const j of [0, height - 1]) {
      const c = j * width + i;
      filled[c] = heights[c] ?? 0;
      closed[c] = 1;
      heap.push(filled[c] ?? 0, c);
    }
  }
  for (let j = 1; j < height - 1; j++) {
    for (const i of [0, width - 1]) {
      const c = j * width + i;
      filled[c] = heights[c] ?? 0;
      closed[c] = 1;
      heap.push(filled[c] ?? 0, c);
    }
  }

  let popped = 0;
  while (heap.size > 0) {
    const c = heap.pop();
    order[popped++] = c;
    const zc = filled[c] ?? 0;
    const ci = c % width;
    const cj = (c / width) | 0;
    for (let d = 1; d <= 8; d++) {
      const ni = ci + (D8_DI[d] ?? 0);
      const nj = cj + (D8_DJ[d] ?? 0);
      if (ni < 0 || nj < 0 || ni >= width || nj >= height) continue;
      const k = nj * width + ni;
      if (closed[k]) continue;
      closed[k] = 1;
      const zn = heights[k] ?? 0;
      const fk = zn > zc ? zn : zc + epsilon;
      filled[k] = fk;
      heap.push(fk, k);
    }
  }
  return { filled, order };
}

/** One connected ponded region — a candidate closed basin. */
export interface DepressionInfo {
  /** Ponded cells in the component. */
  readonly cells: number;
  /** Deepest fill inside the component, meters (spill − pit bottom). */
  readonly depthMeters: number;
  /** The component's lowest raw-elevation cell (the pit bottom). */
  readonly bottomCell: number;
}

export interface Depressions {
  /**
   * Component index per cell, -1 where the cell is not ponded. Component
   * indexes match `list`.
   */
  readonly componentOf: Int32Array;
  readonly list: readonly DepressionInfo[];
}

/**
 * Connected components of genuinely ponded cells — where the MINIMAL
 * fill (`filledMin`, from an epsilon-0 flood) sits above the raw height.
 * The epsilon flood cannot be used for this: it raises every flat it
 * crosses by a growing epsilon ramp, so a draining plateau would look
 * like a huge shallow depression.
 *
 * Depth is the deepest fill inside the component — the difference
 * between the spill elevation and the pit bottom.
 */
export function findDepressions(
  heights: ArrayLike<number>,
  filledMin: ArrayLike<number>,
  width: number,
  height: number,
): Depressions {
  const n = width * height;
  if (heights.length !== n || filledMin.length !== n) {
    throw new Error(
      `findDepressions: heights/filled length != ${width}x${height}`,
    );
  }
  const componentOf = new Int32Array(n).fill(-1);
  const list: DepressionInfo[] = [];
  const queue = new Int32Array(n);
  for (let seed = 0; seed < n; seed++) {
    if (componentOf[seed] !== -1) continue;
    if ((filledMin[seed] ?? 0) <= (heights[seed] ?? 0) + PONDED_TOLERANCE_METERS) {
      continue;
    }
    // BFS over 8-connected ponded cells.
    const id = list.length;
    let head = 0;
    let tail = 0;
    let cells = 0;
    let depthMeters = 0;
    let bottomCell = seed;
    let bottomZ = heights[seed] ?? Infinity;
    componentOf[seed] = id;
    queue[tail++] = seed;
    while (head < tail) {
      const c = queue[head++] ?? -1;
      if (c < 0) break;
      cells += 1;
      const z = heights[c] ?? 0;
      const d = (filledMin[c] ?? 0) - z;
      if (d > depthMeters) depthMeters = d;
      if (z < bottomZ) {
        bottomZ = z;
        bottomCell = c;
      }
      const ci = c % width;
      const cj = (c / width) | 0;
      for (let ddir = 1; ddir <= 8; ddir++) {
        const ni = ci + (D8_DI[ddir] ?? 0);
        const nj = cj + (D8_DJ[ddir] ?? 0);
        if (ni < 0 || nj < 0 || ni >= width || nj >= height) continue;
        const k = nj * width + ni;
        if (componentOf[k] !== -1) continue;
        if ((filledMin[k] ?? 0) <= (heights[k] ?? 0) + PONDED_TOLERANCE_METERS) {
          continue;
        }
        componentOf[k] = id;
        queue[tail++] = k;
      }
    }
    list.push({ cells, depthMeters, bottomCell });
  }
  return { componentOf, list };
}

/**
 * Whether a depression stays a terminal sink: real closed basins are
 * both wide AND deep; smaller ones are DEM noise and get filled.
 */
export function depressionIsRetained(
  d: DepressionInfo,
  areaCells = FILL_AREA_CELLS,
  depthMeters = FILL_DEPTH_METERS,
): boolean {
  return d.cells >= areaCells && d.depthMeters >= depthMeters;
}

/**
 * The elevation surface D8 routes on. Outside retained depressions: the
 * epsilon-filled heights, so flats and small noise pits drain. Inside a
 * retained depression: `raw + eps * dist`, where `dist` is the
 * 8-connected hop distance from the depression's bottom cell — real
 * slopes dominate (meter-scale raw differences >> sub-meter eps terms)
 * and flat floors get a strict gradient toward the bottom, so the whole
 * basin collects into one terminal sink instead of fragmenting into
 * thousands of per-cell puddles. A raw local pit inside a depression
 * still ends FLOW_DIR_NONE — it genuinely is a nested closed sink.
 *
 * `eps` per depression is bounded so the wave stays far below the spill
 * level: at most half the depression's depth across all its cells.
 * `filledMin` supplies the spill elevation; interior z is additionally
 * capped a FLOOD_EPSILON below it so no interior cell can leak outward.
 */
export function routeElevations(
  heights: ArrayLike<number>,
  filled: ArrayLike<number>,
  filledMin: ArrayLike<number>,
  depressions: Depressions,
  width: number,
  height: number,
  areaCells = FILL_AREA_CELLS,
  depthMeters = FILL_DEPTH_METERS,
): Float32Array {
  const n = width * height;
  const z = new Float32Array(n);
  const dist = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const epsOf = new Float64Array(depressions.list.length);
  const capOf = new Float64Array(depressions.list.length);
  depressions.list.forEach((d, id) => {
    if (!depressionIsRetained(d, areaCells, depthMeters)) return;
    const bottom = d.bottomCell;
    epsOf[id] = Math.min(FLOOD_EPSILON, (0.5 * d.depthMeters) / d.cells);
    capOf[id] = (filledMin[bottom] ?? 0) - FLOOD_EPSILON;
    let head = 0;
    let tail = 0;
    dist[bottom] = 0;
    queue[tail++] = bottom;
    while (head < tail) {
      const c = queue[head++] ?? -1;
      if (c < 0) break;
      const ci = c % width;
      const cj = (c / width) | 0;
      const nd = (dist[c] ?? 0) + 1;
      for (let ddir = 1; ddir <= 8; ddir++) {
        const ni = ci + (D8_DI[ddir] ?? 0);
        const nj = cj + (D8_DJ[ddir] ?? 0);
        if (ni < 0 || nj < 0 || ni >= width || nj >= height) continue;
        const k = nj * width + ni;
        if (depressions.componentOf[k] !== id || dist[k] !== -1) continue;
        dist[k] = nd;
        queue[tail++] = k;
      }
    }
  });
  for (let k = 0; k < n; k++) {
    const d = dist[k] ?? -1;
    if (d < 0) {
      z[k] = filled[k] ?? 0;
      continue;
    }
    const comp = depressions.componentOf[k] ?? -1;
    z[k] = Math.min(
      (heights[k] ?? 0) + (epsOf[comp] ?? 0) * d,
      capOf[comp] ?? 0,
    );
  }
  return z;
}

/**
 * D8 flow direction per cell: the strictly-lowest routing neighbor wins,
 * ties break on the fixed direction order (1..8). Cells with no lower
 * neighbor get FLOW_DIR_NONE — the lowest edge sinks and, with selective
 * filling, the pit bottoms of the retained (endorheic) depressions.
 */
export function flowDirectionsD8(
  filled: ArrayLike<number>,
  width: number,
  height: number,
): Uint8Array {
  const n = width * height;
  if (filled.length !== n) {
    throw new Error(
      `flowDirectionsD8: filled length ${filled.length} != ${width}x${height}`,
    );
  }
  const dir = new Uint8Array(n);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const c = j * width + i;
      let best = filled[c] ?? 0;
      let bestD = 0;
      for (let d = 1; d <= 8; d++) {
        const ni = i + (D8_DI[d] ?? 0);
        const nj = j + (D8_DJ[d] ?? 0);
        if (ni < 0 || nj < 0 || ni >= width || nj >= height) continue;
        const z = filled[nj * width + ni] ?? 0;
        if (z < best) {
          best = z;
          bestD = d;
        }
      }
      dir[c] = bestD;
    }
  }
  return dir;
}

/** Downstream cell of `c`, or -1 (no flow / off the grid). */
export function flowTarget(
  dir: Uint8Array,
  c: number,
  width: number,
  height: number,
): number {
  const d = dir[c] ?? 0;
  if (d === 0) return -1;
  const ni = (c % width) + (D8_DI[d] ?? 0);
  const nj = ((c / width) | 0) + (D8_DJ[d] ?? 0);
  if (ni < 0 || nj < 0 || ni >= width || nj >= height) return -1;
  return nj * width + ni;
}

/**
 * Upstream cell count per cell (each cell counts itself). Cells are
 * processed upstream-first — strictly decreasing `z` along every flow
 * path — so a single pass over the z-sorted order accumulates
 * downstream. (The flood pop order cannot be reused: inside a retained
 * depression routing follows raw heights, which do not track it.)
 */
export function flowAccumulation(
  dir: Uint8Array,
  z: ArrayLike<number>,
  width: number,
  height: number,
): Float32Array {
  const n = width * height;
  const order = new Uint32Array(n);
  for (let k = 0; k < n; k++) order[k] = k;
  // Highest routing elevation first; index tie-break for determinism.
  order.sort((a, b) => (z[b] ?? 0) - (z[a] ?? 0) || a - b);
  const acc = new Float32Array(n).fill(1);
  for (let k = 0; k < n; k++) {
    const c = order[k] ?? 0;
    const t = flowTarget(dir, c, width, height);
    if (t >= 0) acc[t] = (acc[t] ?? 0) + (acc[c] ?? 0);
  }
  return acc;
}

export type BasinKind = "cerrada" | "abierta";

export interface BasinInfo {
  /** Basin id in the labels raster (1..MAX_MAIN_BASINS). */
  readonly id: number;
  /**
   * Largest accumulation of the basin's in-province cells — the water
   * volume crossing the boundary at its main river (abierta) or pooling
   * at the bottom of its terminal depression (cerrada).
   */
  readonly outletAcc: number;
  /** In-province cells in the basin. */
  readonly cells: number;
  /**
   * Grid coords of the basin's most-accumulated in-province cell (the
   * pour point where its main river leaves the province, or the deepest
   * in-province reach of the closed basin).
   */
  readonly outlet: readonly [number, number];
  /** Grid coords of the cell the basin's water ends in. */
  readonly terminal: readonly [number, number];
  /**
   * "cerrada" — the terminal is an interior sink inside the province
   * (endorheic: the water ends in a laguna or salar, never the sea);
   * "abierta" — the terminal lies outside the province mask.
   */
  readonly kind: BasinKind;
}

export interface BasinLabels {
  /**
   * Per cell: BASIN_OUTSIDE outside the mask, BASIN_OTHER for in-mask
   * cells of minor basins ("otras"), 1..N for the main basins.
   */
  readonly labels: Uint8Array;
  /** Main basins sorted by outlet accumulation (largest first). */
  readonly basins: readonly BasinInfo[];
}

/**
 * Group in-province cells by the TERMINAL of their flow path: the
 * no-outflow cell the water ends in — a grid-edge sink (abierta) or a
 * retained depression's pit bottom (cerrada). Cells that share the
 * terminal belong to the same drainage system — this merges the
 * fragments a border-hugging river sheds (each boundary cell would
 * otherwise be its own "outlet") and, correctly, unites branches that
 * join outside the province. The `maxBasins` terminals collecting the
 * most water are kept; the rest are "otras".
 *
 * When `depressions` is given, sinks that share one retained component
 * (a pit bottom plus the nested micro-pits on its flat floor) merge
 * into a single cerrada basin — they are all the same closed basin —
 * and the component's bottomCell is the basin's terminal.
 */
export function labelBasins(
  dir: Uint8Array,
  inside: Uint8Array,
  acc: Float32Array,
  width: number,
  height: number,
  maxBasins = MAX_MAIN_BASINS,
  depressions?: Depressions,
  areaCells = FILL_AREA_CELLS,
  depthMeters = FILL_DEPTH_METERS,
): BasinLabels {
  const n = width * height;
  // Sinks sharing one retained depression merge into a single cerrada
  // basin keyed by component (offset by n to never collide with a cell
  // index); the component's pit bottom is the basin's terminal.
  const retained = depressions
    ? Uint8Array.from(depressions.list, (d) =>
        depressionIsRetained(d, areaCells, depthMeters) ? 1 : 0,
      )
    : undefined;
  const componentOf = depressions?.componentOf;
  const groupKey = (t: number): number => {
    const comp = componentOf?.[t] ?? -1;
    return comp >= 0 && retained?.[comp] === 1 ? n + comp : t;
  };
  const groupTerminal = (key: number): number =>
    key >= n ? (depressions?.list[key - n]?.bottomCell ?? 0) : key;

  // terminal[c] = the FLOW_DIR_NONE cell c drains to; -2 = unresolved.
  const terminal = new Int32Array(n).fill(-2);
  for (let k = 0; k < n; k++) {
    if (!inside[k] || terminal[k] !== -2) continue;
    // Walk the chain to its sink; path holds every visited cell
    // (inside and outside) for compression — chains are acyclic
    // because filled elevation strictly decreases along them.
    const path: number[] = [];
    let c = k;
    for (;;) {
      const t = terminal[c] ?? -2;
      if (t !== -2) break;
      path.push(c);
      const next = flowTarget(dir, c, width, height);
      if (next < 0) {
        terminal[c] = c;
        break;
      }
      c = next;
      if (path.length > n) {
        throw new Error("labelBasins: flow chain longer than the grid");
      }
    }
    const t = terminal[c] ?? c;
    for (const p of path) terminal[p] = t;
  }

  // In-province cells per terminal + the group's strongest inside cell
  // (the main river crossing the boundary).
  interface Group {
    cells: number;
    outletCell: number;
    outletAcc: number;
  }
  const groups = new Map<number, Group>();
  for (let k = 0; k < n; k++) {
    if (!inside[k]) continue;
    const t = terminal[k] ?? -1;
    if (t < 0) continue;
    const key = groupKey(t);
    const a = acc[k] ?? 0;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { cells: 1, outletCell: k, outletAcc: a });
    } else {
      g.cells++;
      if (a > g.outletAcc) {
        g.outletCell = k;
        g.outletAcc = a;
      }
    }
  }
  const ranked = [...groups.entries()].sort(
    (a, b) => b[1].outletAcc - a[1].outletAcc || a[0] - b[0],
  );
  const basinOfTerminal = new Map<number, number>();
  const basins: BasinInfo[] = [];
  for (const [key, g] of ranked.slice(0, maxBasins)) {
    const id = basins.length + 1;
    const t = groupTerminal(key);
    basinOfTerminal.set(key, id);
    basins.push({
      id,
      outletAcc: g.outletAcc,
      cells: g.cells,
      outlet: [g.outletCell % width, (g.outletCell / width) | 0],
      terminal: [t % width, (t / width) | 0],
      kind: key >= n || inside[t] ? "cerrada" : "abierta",
    });
  }

  const labels = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (!inside[k]) {
      labels[k] = BASIN_OUTSIDE;
    } else {
      labels[k] =
        basinOfTerminal.get(groupKey(terminal[k] ?? -1)) ?? BASIN_OTHER;
    }
  }
  return { labels, basins };
}

/**
 * Accumulation for the client: log2(acc) * ACC_LOG2_SCALE, rounded to
 * Uint16. acc >= 1 by construction; values below 1 clamp to 0.
 */
export function encodeAccLog2(acc: Float32Array): Uint16Array {
  const out = new Uint16Array(acc.length);
  for (let k = 0; k < acc.length; k++) {
    const a = acc[k] ?? 0;
    out[k] = a <= 1 ? 0 : Math.round(Math.log2(a) * ACC_LOG2_SCALE);
  }
  return out;
}

/**
 * Cell indices where `inside` is nonzero, row-major — the uniform-area
 * spawn list the rain particles draw from (one entry per cell = exactly
 * area-weighted random spawning).
 */
export function buildSpawnCells(
  inside: Uint8Array,
  width: number,
  height: number,
): Uint32Array {
  const n = width * height;
  const out = new Uint32Array(n);
  let count = 0;
  for (let k = 0; k < n; k++) {
    if (inside[k]) out[count++] = k;
  }
  return out.subarray(0, count);
}

/**
 * Accumulation threshold for the "red hídrica" emphasis: the acc value
 * at rank `fraction` of in-mask cells sorted descending (e.g. 0.015 →
 * roughly the top 1.5% most-collecting cells count as rivers).
 */
export function riverThreshold(
  acc: Float32Array,
  inside: Uint8Array,
  fraction: number,
): number {
  const values: number[] = [];
  for (let k = 0; k < acc.length; k++) {
    if (inside[k]) values.push(acc[k] ?? 0);
  }
  if (values.length === 0) return Infinity;
  values.sort((a, b) => b - a);
  const rank = Math.min(
    values.length - 1,
    Math.max(0, Math.ceil(values.length * fraction) - 1),
  );
  return values[rank] ?? Infinity;
}
