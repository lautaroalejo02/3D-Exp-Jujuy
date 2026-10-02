/**
 * Pure raster helpers for the data pipeline: Terrarium DEM decoding,
 * cropping, box-filter downsampling and hillshading. All grids are
 * row-major, j indexes rows southward, i indexes columns eastward.
 */

const DEG = Math.PI / 180;

/** Terrarium decoding for a single pixel: meters above sea level. */
export function decodeTerrariumHeight(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** Decode a whole RGBA Terrarium tile/mosaic into float heights (meters). */
export function decodeTerrarium(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array {
  if (rgba.length !== width * height * 4) {
    throw new Error(
      `Terrarium RGBA length ${rgba.length} does not match ${width}x${height}`,
    );
  }
  const out = new Float32Array(width * height);
  for (let p = 0, k = 0; k < out.length; p += 4, k++) {
    out[k] = decodeTerrariumHeight(
      rgba[p] ?? 0,
      rgba[p + 1] ?? 0,
      rgba[p + 2] ?? 0,
    );
  }
  return out;
}

/** Copy a width x height window starting at (x, y) out of a Float32 grid. */
export function cropGrid(
  src: Float32Array,
  srcWidth: number,
  srcHeight: number,
  x: number,
  y: number,
  width: number,
  height: number,
): Float32Array {
  if (src.length !== srcWidth * srcHeight) {
    throw new Error(
      `cropGrid: source length ${src.length} != ${srcWidth}x${srcHeight}`,
    );
  }
  if (x < 0 || y < 0 || x + width > srcWidth || y + height > srcHeight) {
    throw new Error(
      `cropGrid: window (${x},${y} ${width}x${height}) outside ${srcWidth}x${srcHeight}`,
    );
  }
  const out = new Float32Array(width * height);
  for (let j = 0; j < height; j++) {
    const srcRow = (y + j) * srcWidth + x;
    out.set(src.subarray(srcRow, srcRow + width), j * width);
  }
  return out;
}

/**
 * Bilinear sample of a row-major grid at fractional cell coords (i, j),
 * where integer coords are cell centers. Samples are clamped to the
 * borders, so coordinates outside [0, width-1] x [0, height-1] reuse the
 * edge values.
 */
export function bilinearSample(
  grid: ArrayLike<number>,
  width: number,
  height: number,
  i: number,
  j: number,
): number {
  const ci = Math.min(width - 1, Math.max(0, i));
  const cj = Math.min(height - 1, Math.max(0, j));
  const i0 = Math.floor(ci);
  const j0 = Math.floor(cj);
  const i1 = Math.min(i0 + 1, width - 1);
  const j1 = Math.min(j0 + 1, height - 1);
  const fx = ci - i0;
  const fy = cj - j0;
  const top =
    (grid[j0 * width + i0] ?? 0) +
    ((grid[j0 * width + i1] ?? 0) - (grid[j0 * width + i0] ?? 0)) * fx;
  const bot =
    (grid[j1 * width + i0] ?? 0) +
    ((grid[j1 * width + i1] ?? 0) - (grid[j1 * width + i0] ?? 0)) * fx;
  return top + (bot - top) * fy;
}

/**
 * 2D box-filter downsample of a float grid. Output size is ceil(dim/factor);
 * partial blocks at the right/bottom edges average only the cells present.
 */
export function boxDownsample(
  src: Float32Array,
  width: number,
  height: number,
  factor: number,
): { data: Float32Array; width: number; height: number } {
  if (src.length !== width * height) {
    throw new Error(
      `boxDownsample: source length ${src.length} != ${width}x${height}`,
    );
  }
  if (!Number.isInteger(factor) || factor < 1) {
    throw new Error(
      `boxDownsample: factor must be an integer >= 1, got ${factor}`,
    );
  }
  const outW = Math.ceil(width / factor);
  const outH = Math.ceil(height / factor);
  const data = new Float32Array(outW * outH);
  for (let j = 0; j < outH; j++) {
    const j0 = j * factor;
    const j1 = Math.min(j0 + factor, height);
    for (let i = 0; i < outW; i++) {
      const i0 = i * factor;
      const i1 = Math.min(i0 + factor, width);
      let sum = 0;
      let count = 0;
      for (let jj = j0; jj < j1; jj++) {
        for (let ii = i0; ii < i1; ii++) {
          sum += src[jj * width + ii] ?? 0;
          count++;
        }
      }
      data[j * outW + i] = sum / count;
    }
  }
  return { data, width: outW, height: outH };
}

/** Same box filter on an interleaved RGBA image; channels are averaged and rounded. */
export function boxDownsampleRgba(
  src: Uint8Array,
  width: number,
  height: number,
  factor: number,
): { data: Uint8Array; width: number; height: number } {
  if (src.length !== width * height * 4) {
    throw new Error(
      `boxDownsampleRgba: source length ${src.length} != ${width}x${height}x4`,
    );
  }
  if (!Number.isInteger(factor) || factor < 1) {
    throw new Error(
      `boxDownsampleRgba: factor must be an integer >= 1, got ${factor}`,
    );
  }
  const outW = Math.ceil(width / factor);
  const outH = Math.ceil(height / factor);
  const data = new Uint8Array(outW * outH * 4);
  for (let j = 0; j < outH; j++) {
    const j0 = j * factor;
    const j1 = Math.min(j0 + factor, height);
    for (let i = 0; i < outW; i++) {
      const i0 = i * factor;
      const i1 = Math.min(i0 + factor, width);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let jj = j0; jj < j1; jj++) {
        for (let ii = i0; ii < i1; ii++) {
          const p = (jj * width + ii) * 4;
          r += src[p] ?? 0;
          g += src[p + 1] ?? 0;
          b += src[p + 2] ?? 0;
          a += src[p + 3] ?? 0;
          count++;
        }
      }
      const q = (j * outW + i) * 4;
      data[q] = Math.round(r / count);
      data[q + 1] = Math.round(g / count);
      data[q + 2] = Math.round(b / count);
      data[q + 3] = Math.round(a / count);
    }
  }
  return { data, width: outW, height: outH };
}

/**
 * Grayscale hillshade (one byte per cell, 0..255) for a height grid.
 * Grid axes: i east, j south. Light comes from `azimuthDeg` (clockwise from
 * north; 315 = NW) at `altitudeDeg` above the horizon. `cellSizeMeters` is
 * the real ground size of one cell so slopes are physically meaningful.
 */
export function hillshade(
  heights: ArrayLike<number>,
  width: number,
  height: number,
  cellSizeMeters: number,
  azimuthDeg = 315,
  altitudeDeg = 45,
): Uint8Array {
  if (heights.length !== width * height) {
    throw new Error(
      `hillshade: heights length ${heights.length} != ${width}x${height}`,
    );
  }
  const az = azimuthDeg * DEG;
  const sinAlt = Math.sin(altitudeDeg * DEG);
  const cosAlt = Math.cos(altitudeDeg * DEG);
  // Unit vector pointing from the surface toward the sun, in (east, south, up).
  const lx = Math.sin(az) * cosAlt;
  const ly = -Math.cos(az) * cosAlt;
  const lz = sinAlt;

  const out = new Uint8Array(width * height);
  const at = (i: number, j: number): number => {
    const ci = Math.min(width - 1, Math.max(0, i));
    const cj = Math.min(height - 1, Math.max(0, j));
    return heights[cj * width + ci] ?? 0;
  };
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      // Horn's method (3x3 neighborhood).
      const dzdx =
        (at(i + 1, j - 1) +
          2 * at(i + 1, j) +
          at(i + 1, j + 1) -
          (at(i - 1, j - 1) + 2 * at(i - 1, j) + at(i - 1, j + 1))) /
        (8 * cellSizeMeters);
      const dzdy =
        (at(i - 1, j + 1) +
          2 * at(i, j + 1) +
          at(i + 1, j + 1) -
          (at(i - 1, j - 1) + 2 * at(i, j - 1) + at(i + 1, j - 1))) /
        (8 * cellSizeMeters);
      // Surface normal = (-dzdx, -dzdy, 1); intensity = max(0, n . l) / |n|.
      const intensity = Math.max(
        0,
        (-dzdx * lx - dzdy * ly + lz) / Math.hypot(dzdx, dzdy, 1),
      );
      out[j * width + i] = Math.round(Math.min(1, intensity) * 255);
    }
  }
  return out;
}
