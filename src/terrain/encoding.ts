/**
 * Int16 little-endian encoding for elevation samples in meters, row-major.
 * Shared between the data pipeline (scripts/build-data.ts) and the client.
 * DataView is used explicitly so byte order never depends on platform
 * endianness.
 */

export const HEIGHTS_ENCODING = {
  format: "int16",
  endianness: "little",
  units: "meters",
  layout: "row-major",
} as const;

const INT16_MIN = -32768;
const INT16_MAX = 32767;

/**
 * Round each height to the nearest meter (Math.round: halves go toward
 * +Infinity) and clamp into the Int16 range.
 */
export function encodeHeightsLE(heights: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(heights.length * 2);
  const view = new DataView(out.buffer);
  for (let k = 0; k < heights.length; k++) {
    const rounded = Math.round(heights[k] ?? 0);
    view.setInt16(
      k * 2,
      Math.min(INT16_MAX, Math.max(INT16_MIN, rounded)),
      true,
    );
  }
  return out;
}

/** Inverse of encodeHeightsLE. Throws on an odd byte count. */
export function decodeHeightsLE(bytes: Uint8Array | ArrayBuffer): Int16Array {
  const view =
    bytes instanceof Uint8Array
      ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new DataView(bytes);
  if (view.byteLength % 2 !== 0) {
    throw new Error(
      `Int16 heightfield payload has odd byte length ${view.byteLength}`,
    );
  }
  const out = new Int16Array(view.byteLength / 2);
  for (let k = 0; k < out.length; k++) {
    out[k] = view.getInt16(k * 2, true);
  }
  return out;
}
