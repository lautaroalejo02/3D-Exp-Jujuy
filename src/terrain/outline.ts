/**
 * Province outline extraction for the cut wall (stage Bordes): marching
 * squares over the Int8 province SDF raster, in the raster's own grid
 * coords (cell centers at integer coords, j southward). The iso-0
 * contour becomes the closed polyline the diorama hangs the province
 * wall from — same SDF the shaders sample, so the wall stands exactly
 * on the drawn inside/outside boundary.
 *
 * Conventions:
 * - inside = sdf >= 0 (the same sign split the shaders use);
 * - the returned ring is wound so its shoelace area is POSITIVE —
 *   in (i,j) coords the interior then stays on the left of travel,
 *   and `vec3f(d.y, 0, -d.x)` of each segment is the outward normal
 *   the cut-wall shader uses;
 * - only the LONGEST ring is kept: Jujuy is one connected province, so
 *   any extra rings would be raster noise.
 *
 * Pure functions, no GPU — the data pipeline (build-data) writes the
 * result as a Float32 .bin the diorama uploads as a storage buffer.
 */

/**
 * Iso-0 crossing between two SDF cells. `t` interpolates from cell a to
 * cell b; undefined when both cells fall on the same side.
 */
function crossingT(a: number, b: number): number | undefined {
  const inA = a >= 0;
  const inB = b >= 0;
  if (inA === inB) return undefined;
  return a / (a - b);
}

/** Edge keys identify a grid edge shared by up to two texel quads. */
const hEdge = (i: number, j: number): string => `h${i},${j}`; // (i,j)-(i+1,j)
const vEdge = (i: number, j: number): string => `v${i},${j}`; // (i,j)-(i,j+1)

/**
 * All iso-0 rings of the SDF, unsimplified, as flat [i0,j0, i1,j1, ...]
 * Float32Arrays wound with positive shoelace area. Open chains (contours
 * touching the raster border) are discarded — the wall must be a loop.
 */
export function sdfOutlineRings(
  sdf: ArrayLike<number>,
  width: number,
  height: number,
): Float32Array[] {
  if (sdf.length !== width * height) {
    throw new Error(
      `sdfOutlineRings: sdf length ${sdf.length} != ${width}x${height}`,
    );
  }
  const at = (i: number, j: number): number => sdf[j * width + i] ?? 0;

  // Crossing position per grid edge (the edge is the node the marched
  // segments connect through).
  const point = new Map<string, [number, number]>();
  // Segments: pairs of edge keys the contour connects inside one quad.
  const segs: Array<readonly [string, string]> = [];
  const byEdge = new Map<string, number[]>();
  const addSeg = (a: string, b: string): void => {
    const idx = segs.length;
    segs.push([a, b]);
    (byEdge.get(a) ?? byEdge.set(a, []).get(a)!).push(idx);
    (byEdge.get(b) ?? byEdge.set(b, []).get(b)!).push(idx);
  };

  for (let j = 0; j + 1 < height; j++) {
    for (let i = 0; i + 1 < width; i++) {
      const v00 = at(i, j); // TL
      const v10 = at(i + 1, j); // TR
      const v01 = at(i, j + 1); // BL
      const v11 = at(i + 1, j + 1); // BR
      // Crossings on edges T, R, B, L (in that order).
      const c: { edge: string; pt: [number, number] }[] = [];
      const tT = crossingT(v00, v10);
      if (tT !== undefined)
        c.push({ edge: hEdge(i, j), pt: [i + tT, j] });
      const tR = crossingT(v10, v11);
      if (tR !== undefined)
        c.push({ edge: vEdge(i + 1, j), pt: [i + 1, j + tR] });
      const tB = crossingT(v01, v11);
      if (tB !== undefined)
        c.push({ edge: hEdge(i, j + 1), pt: [i + tB, j + 1] });
      const tL = crossingT(v00, v01);
      if (tL !== undefined)
        c.push({ edge: vEdge(i, j), pt: [i, j + tL] });
      if (c.length === 0) continue;
      for (const k of c) point.set(k.edge, k.pt);
      if (c.length === 2) {
        addSeg(c[0]!.edge, c[1]!.edge);
      } else if (c.length === 4) {
        // Saddle: the corner-mean sign decides which side connects
        // through the quad's center (asymptotic decider).
        const tlInside = v00 >= 0;
        const joinInside = v00 + v10 + v01 + v11 >= 0;
        if (tlInside === joinInside) {
          // Center belongs to TL's side: TR and BL are isolated
          // (T,R) bounds TR; (L,B) bounds BL.
          addSeg(c[0]!.edge, c[1]!.edge);
          addSeg(c[2]!.edge, c[3]!.edge);
        } else {
          // (T,L) bounds TL; (B,R) bounds BR.
          addSeg(c[0]!.edge, c[3]!.edge);
          addSeg(c[1]!.edge, c[2]!.edge);
        }
      }
    }
  }

  // Chain segments into loops: every interior edge key is shared by
  // exactly two segments, so following the unused neighbor walks a ring.
  const visited = new Uint8Array(segs.length);
  const rings: Float32Array[] = [];
  for (let s = 0; s < segs.length; s++) {
    if (visited[s] === 1) continue;
    const [a0, b0] = segs[s]!;
    visited[s] = 1;
    const ring: number[] = [];
    const pA = point.get(a0);
    if (!pA) continue;
    ring.push(pA[0], pA[1]);
    let node = b0;
    let closed = false;
    for (;;) {
      if (node === a0) {
        closed = true;
        break;
      }
      const p = point.get(node);
      if (!p) break;
      ring.push(p[0], p[1]);
      const next = (byEdge.get(node) ?? []).find((k) => visited[k] === 0);
      if (next === undefined) break; // open chain — drop it
      visited[next] = 1;
      const [na, nb] = segs[next]!;
      node = na === node ? nb : na;
    }
    if (closed && ring.length >= 6) {
      rings.push(Float32Array.from(ring));
    }
  }
  for (const ring of rings) {
    if (signedArea(ring) < 0) reverseRing(ring);
  }
  return rings;
}

/** Shoelace signed area of a flat [x,y,...] ring (positive = CCW). */
export function signedArea(ring: ArrayLike<number>): number {
  const n = ring.length / 2;
  let a = 0;
  for (let k = 0; k < n; k++) {
    const x0 = ring[k * 2] ?? 0;
    const y0 = ring[k * 2 + 1] ?? 0;
    const x1 = ring[((k + 1) % n) * 2] ?? 0;
    const y1 = ring[((k + 1) % n) * 2 + 1] ?? 0;
    a += x0 * y1 - x1 * y0;
  }
  return a * 0.5;
}

function reverseRing(ring: Float32Array): void {
  const n = ring.length / 2;
  for (let k = 0; k < (n >> 1); k++) {
    const o = n - 1 - k;
    const x = ring[k * 2]!;
    const y = ring[k * 2 + 1]!;
    ring[k * 2] = ring[o * 2]!;
    ring[k * 2 + 1] = ring[o * 2 + 1]!;
    ring[o * 2] = x;
    ring[o * 2 + 1] = y;
  }
}

/** Perimeter of a flat ring in grid cells (closed loop assumed). */
function perimeter(ring: ArrayLike<number>): number {
  const n = ring.length / 2;
  let p = 0;
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    p += Math.hypot(
      (ring[k2 * 2] ?? 0) - (ring[k * 2] ?? 0),
      (ring[k2 * 2 + 1] ?? 0) - (ring[k * 2 + 1] ?? 0),
    );
  }
  return p;
}

/**
 * Douglas-Peucker on an open polyline (flat [x,y,...]); returns the
 * kept vertex indices into the polyline's vertex array.
 */
function dpKeep(
  pts: ArrayLike<number>,
  first: number,
  last: number,
  tolerance: number,
  keep: Set<number>,
): void {
  keep.add(first);
  keep.add(last);
  if (last <= first + 1) return;
  const ax = pts[first * 2] ?? 0;
  const ay = pts[first * 2 + 1] ?? 0;
  const bx = pts[last * 2] ?? 0;
  const by = pts[last * 2 + 1] ?? 0;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  let worst = -1;
  let worstD = tolerance;
  for (let k = first + 1; k < last; k++) {
    const px = pts[k * 2] ?? 0;
    const py = pts[k * 2 + 1] ?? 0;
    // Point-to-segment distance.
    let d: number;
    if (len < 1e-9) {
      d = Math.hypot(px - ax, py - ay);
    } else {
      const t = Math.min(
        1,
        Math.max(0, ((px - ax) * dx + (py - ay) * dy) / (len * len)),
      );
      d = Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
    }
    if (d > worstD) {
      worstD = d;
      worst = k;
    }
  }
  if (worst >= 0) {
    dpKeep(pts, first, worst, tolerance, keep);
    dpKeep(pts, worst, last, tolerance, keep);
  }
}

/**
 * Simplify a CLOSED ring with Douglas-Peucker: split it at the two
 * farthest-apart vertices, simplify each arc as an open polyline, and
 * rejoin. The boundary keeps its character while tiny stair-steps
 * collapse; returns fewer than 3 points only for degenerate input.
 */
export function simplifyRing(
  ring: Float32Array,
  toleranceCells: number,
): Float32Array {
  const n = ring.length / 2;
  if (n <= 3 || toleranceCells <= 0) return ring;
  // Two split anchors: farthest from ring[0], then farthest from that.
  const farthest = (from: number): number => {
    let best = 0;
    let bestD = -1;
    for (let k = 0; k < n; k++) {
      const d = Math.hypot(
        (ring[k * 2] ?? 0) - (ring[from * 2] ?? 0),
        (ring[k * 2 + 1] ?? 0) - (ring[from * 2 + 1] ?? 0),
      );
      if (d > bestD) {
        bestD = d;
        best = k;
      }
    }
    return best;
  };
  const a = farthest(0);
  const b = farthest(a);
  if (a === b) return ring;

  // Unroll the ring into a polyline starting at a, going through b once.
  const unrolled: number[] = [];
  for (let k = 0; k <= n; k++) {
    const idx = (a + k) % n;
    unrolled.push(ring[idx * 2] ?? 0, ring[idx * 2 + 1] ?? 0);
  }
  const bIdx = (b - a + n) % n;
  // Arc 1: a -> b (indices 0..bIdx); arc 2: b -> a wrap (bIdx..n).
  const keep = new Set<number>();
  dpKeep(unrolled, 0, bIdx, toleranceCells, keep);
  dpKeep(unrolled, bIdx, n, toleranceCells, keep);
  const kept = [...keep].sort((x, y) => x - y).filter((k) => k < n);
  const out = new Float32Array(kept.length * 2);
  kept.forEach((k, w) => {
    out[w * 2] = unrolled[k * 2] ?? 0;
    out[w * 2 + 1] = unrolled[k * 2 + 1] ?? 0;
  });
  return out.length >= 6 ? out : ring;
}

/**
 * The province outline as ONE closed ring in SDF-grid coords: longest
 * iso-0 ring, wound positive, simplified to `toleranceCells`. Returns
 * undefined when the raster has no closed contour.
 */
export function provinceOutlineRing(
  sdf: ArrayLike<number>,
  width: number,
  height: number,
  toleranceCells = 0.5,
): Float32Array | undefined {
  const rings = sdfOutlineRings(sdf, width, height);
  if (rings.length === 0) return undefined;
  let best = rings[0]!;
  for (const r of rings) {
    if (perimeter(r) > perimeter(best)) best = r;
  }
  return simplifyRing(best, toleranceCells);
}
