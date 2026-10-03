/**
 * Exact Euclidean distance transform (Felzenszwalb & Huttenlocher's
 * separable algorithm) and the signed distance field used for crisp
 * province outlines: positive inside the province, negative outside, in
 * grid-cell units, clamped to +/-127 and stored as Int8.
 */

const INF = 1e20;
const SDF_CLAMP = 127;

/**
 * Squared 1-D EDT: d[q] = min_p (q - p)^2 + f[p]. Runs in O(n) using the
 * lower envelope of parabolas. `v`/`z` are scratch buffers (v has n
 * elements, z has n + 1).
 */
function edt1d(
  f: Float64Array,
  d: Float64Array,
  v: Int32Array,
  z: Float64Array,
  n: number,
): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s =
      ((f[q] ?? 0) + q * q - ((f[v[k] ?? 0] ?? 0) + (v[k] ?? 0) * (v[k] ?? 0))) /
      (2 * q - 2 * (v[k] ?? 0));
    while (s <= (z[k] ?? 0)) {
      k--;
      s =
        ((f[q] ?? 0) +
          q * q -
          ((f[v[k] ?? 0] ?? 0) + (v[k] ?? 0) * (v[k] ?? 0))) /
        (2 * q - 2 * (v[k] ?? 0));
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while ((z[k + 1] ?? 0) < q) k++;
    const p = v[k] ?? 0;
    d[q] = (q - p) * (q - p) + (f[p] ?? 0);
  }
}

/**
 * Squared distance from every cell to the nearest zero cell of `seeds`
 * (cells with value 0 are the distance targets). Column pass then row
 * pass; the separable EDT gives exact Euclidean distances, not an
 * approximation.
 */
export function squaredDistanceToZero(
  seeds: Uint8Array,
  width: number,
  height: number,
): Float64Array {
  if (seeds.length !== width * height) {
    throw new Error(
      `squaredDistanceToZero: seeds length ${seeds.length} != ${width}x${height}`,
    );
  }
  const maxN = Math.max(width, height);
  const f = new Float64Array(maxN);
  const d = new Float64Array(maxN);
  const v = new Int32Array(maxN);
  const z = new Float64Array(maxN + 1);
  // Column pass: g[i + j*w] = min over rows p of (j - p)^2 + seeds[p, i].
  const g = new Float64Array(width * height);
  for (let i = 0; i < width; i++) {
    for (let j = 0; j < height; j++) {
      f[j] = (seeds[j * width + i] ?? 0) === 0 ? 0 : INF;
    }
    edt1d(f, d, v, z, height);
    for (let j = 0; j < height; j++) {
      g[j * width + i] = d[j] ?? 0;
    }
  }
  // Row pass over g.
  const out = new Float64Array(width * height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      f[i] = g[j * width + i] ?? 0;
    }
    edt1d(f, d, v, z, width);
    for (let i = 0; i < width; i++) {
      out[j * width + i] = d[i] ?? 0;
    }
  }
  return out;
}

/**
 * Signed distance to the boundary of a binary mask (1 = inside the
 * province), in cell units: inside cells get +distance to the nearest
 * outside cell, outside cells get -distance to the nearest inside cell.
 * Values are rounded and clamped to +/-127 for Int8 storage. Cells whose
 * distance exceeds 127 (deep interior or far outside) saturate — a shader
 * only needs the sign and the near-boundary gradient.
 */
export function signedDistanceField(
  inside: Uint8Array,
  width: number,
  height: number,
): Int8Array {
  if (inside.length !== width * height) {
    throw new Error(
      `signedDistanceField: mask length ${inside.length} != ${width}x${height}`,
    );
  }
  // Distance to the nearest outside cell: outside cells are the seeds.
  const seedsOutside = new Uint8Array(inside.length);
  // Distance to the nearest inside cell: inside cells are the seeds, so
  // the seed array marks them with 0.
  const seedsInside = new Uint8Array(inside.length);
  for (let c = 0; c < inside.length; c++) {
    const isIn = (inside[c] ?? 0) !== 0;
    seedsOutside[c] = isIn ? 1 : 0;
    seedsInside[c] = isIn ? 0 : 1;
  }
  const distToOutside = squaredDistanceToZero(seedsOutside, width, height);
  const distToInside = squaredDistanceToZero(seedsInside, width, height);
  const out = new Int8Array(inside.length);
  for (let c = 0; c < inside.length; c++) {
    const d =
      (inside[c] ?? 0) !== 0
        ? Math.sqrt(distToOutside[c] ?? 0)
        : -Math.sqrt(distToInside[c] ?? 0);
    out[c] = Math.min(SDF_CLAMP, Math.max(-SDF_CLAMP, Math.round(d)));
  }
  return out;
}
