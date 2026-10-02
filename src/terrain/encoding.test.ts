import { describe, expect, it } from "vitest";

import { decodeHeightsLE, encodeHeightsLE } from "./encoding";

describe("encodeHeightsLE", () => {
  it("rounds to the nearest meter (halves toward +Infinity)", () => {
    const bytes = encodeHeightsLE([1.4, 1.5, -1.4, -1.5, 1000.6]);
    expect(Array.from(decodeHeightsLE(bytes))).toEqual([1, 2, -1, -1, 1001]);
  });

  it("writes little-endian bytes", () => {
    const bytes = encodeHeightsLE([1000, -2]);
    expect(Array.from(bytes)).toEqual([0xe8, 0x03, 0xfe, 0xff]);
  });

  it("clamps into the Int16 range", () => {
    const bytes = encodeHeightsLE([40000, -40000]);
    expect(Array.from(decodeHeightsLE(bytes))).toEqual([32767, -32768]);
  });
});

describe("decodeHeightsLE", () => {
  it("rejects an odd byte count", () => {
    expect(() => decodeHeightsLE(new Uint8Array(3))).toThrow(/odd byte length/);
  });

  it("accepts a Uint8Array view with a nonzero byte offset", () => {
    const buf = new Uint8Array([0xff, 0xff, 0x2a, 0x00, 0xaa]);
    const view = buf.subarray(2, 4);
    expect(Array.from(decodeHeightsLE(view))).toEqual([42]);
  });
});
