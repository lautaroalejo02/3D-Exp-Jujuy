import { describe, expect, it } from "vitest";

import { gridToLonLat, type GridSpec } from "../geo/grid";
import {
  bboxContainsPoint,
  fillPolygon,
  geometryToPolygons,
  majorityDownsampleIndex,
  normalizeDepartmentName,
  nonzeroCellBounds,
  polygonsBBox,
  rasterizeDepartments,
  unionBBox,
  vertexCentroid,
  type LinearRing,
  type PolygonRings,
} from "./raster-vector";

/** Small spec shaped like the real DEM grid (z10, scale 1). */
const SPEC: GridSpec = {
  zoom: 10,
  originPx: [82048, 147200],
  width: 8,
  height: 8,
  scale: 1,
};

/**
 * Ring whose vertices are given in fractional grid coordinates (cell
 * centers are integers), converted to lon/lat through the spec — the same
 * round-trip the pipeline does.
 */
function gridRing(spec: GridSpec, coords: readonly (readonly [number, number])[]): LinearRing {
  const ring = coords.map(([i, j]) => gridToLonLat(spec, i, j));
  ring.push(ring[0] ?? [0, 0]);
  return ring as LinearRing;
}

function filledCells(
  out: Uint8Array,
  width: number,
  height: number,
): { value: number; cells: [number, number][] }[] {
  const byValue = new Map<number, [number, number][]>();
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const v = out[j * width + i] ?? 0;
      if (v === 0) continue;
      const list = byValue.get(v) ?? [];
      list.push([i, j]);
      byValue.set(v, list);
    }
  }
  return [...byValue.entries()].map(([value, cells]) => ({ value, cells }));
}

describe("normalizeDepartmentName", () => {
  it("strips accents, case and punctuation", () => {
    expect(normalizeDepartmentName("Yaví")).toBe("yavi");
    expect(normalizeDepartmentName("Dr. Manuel Belgrano")).toBe(
      "drmanuelbelgrano",
    );
    expect(normalizeDepartmentName("Palpalá")).toBe("palpala");
    expect(normalizeDepartmentName("Santa Bárbara")).toBe("santabarbara");
  });
});

describe("geometryToPolygons", () => {
  it("accepts a Polygon as a single polygon with its rings", () => {
    const polygon = geometryToPolygons({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    });
    expect(polygon).toHaveLength(1);
    expect(polygon[0]).toHaveLength(1);
  });

  it("accepts a MultiPolygon as several polygons", () => {
    const square = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ];
    const polygons = geometryToPolygons({
      type: "MultiPolygon",
      coordinates: [[square], [square, square]],
    });
    expect(polygons).toHaveLength(2);
    expect(polygons[1]).toHaveLength(2);
  });

  it("rejects non-polygon geometry and malformed rings", () => {
    expect(() =>
      geometryToPolygons({ type: "Point", coordinates: [0, 0] }),
    ).toThrow(/unsupported geometry type/);
    expect(() =>
      geometryToPolygons({ type: "Polygon", coordinates: [[[0, 0]]] }),
    ).toThrow(/linear ring/);
  });
});

describe("fillPolygon", () => {
  it("fills exactly the cells whose centers are inside a square", () => {
    const out = new Uint8Array(SPEC.width * SPEC.height);
    const square: PolygonRings = [
      gridRing(SPEC, [
        [0.5, 0.5],
        [3.5, 0.5],
        [3.5, 2.5],
        [0.5, 2.5],
      ]),
    ];
    fillPolygon(SPEC, square, 7, out);
    expect(filledCells(out, SPEC.width, SPEC.height)).toEqual([
      {
        value: 7,
        cells: [
          [1, 1],
          [2, 1],
          [3, 1],
          [1, 2],
          [2, 2],
          [3, 2],
        ],
      },
    ]);
  });

  it("leaves hole cells empty (even-odd rule)", () => {
    const out = new Uint8Array(SPEC.width * SPEC.height);
    const donut: PolygonRings = [
      gridRing(SPEC, [
        [0.5, 0.5],
        [5.5, 0.5],
        [5.5, 5.5],
        [0.5, 5.5],
      ]),
      gridRing(SPEC, [
        [2.5, 2.5],
        [3.5, 2.5],
        [3.5, 3.5],
        [2.5, 3.5],
      ]),
    ];
    fillPolygon(SPEC, donut, 1, out);
    const cells = filledCells(out, SPEC.width, SPEC.height)[0]?.cells ?? [];
    expect(cells).toHaveLength(24);
    expect(cells).not.toContainEqual([3, 3]);
    expect(out[3 * SPEC.width + 3]).toBe(0);
  });
});

describe("rasterizeDepartments", () => {
  it("assigns 1-based indices and keeps disjoint departments apart", () => {
    const west: PolygonRings[] = [
      [
        gridRing(SPEC, [
          [0.5, 0.5],
          [2.5, 0.5],
          [2.5, 2.5],
          [0.5, 2.5],
        ]),
      ],
    ];
    const east: PolygonRings[] = [
      [
        gridRing(SPEC, [
          [4.5, 4.5],
          [6.5, 4.5],
          [6.5, 6.5],
          [4.5, 6.5],
        ]),
      ],
      // Second polygon of the same department (MultiPolygon equivalent).
      [
        gridRing(SPEC, [
          [0.5, 6.5],
          [1.5, 6.5],
          [1.5, 7.5],
          [0.5, 7.5],
        ]),
      ],
    ];
    const out = rasterizeDepartments(SPEC, [west, east]);
    expect(out[1 * SPEC.width + 1]).toBe(1);
    expect(out[2 * SPEC.width + 2]).toBe(1);
    expect(out[5 * SPEC.width + 5]).toBe(2);
    expect(out[6 * SPEC.width + 6]).toBe(2);
    expect(out[7 * SPEC.width + 1]).toBe(2);
    expect(out[4 * SPEC.width + 3]).toBe(0);
  });

  it("partitions a shared border with no gap and no overlap", () => {
    // Shared edge exactly on a cell-center column (x = 3.0). Which side
    // wins the center column is a float-round-trip detail; what matters is
    // that every cell is claimed exactly once.
    const left: PolygonRings[] = [
      [
        gridRing(SPEC, [
          [0.5, 0.5],
          [3.0, 0.5],
          [3.0, 2.5],
          [0.5, 2.5],
        ]),
      ],
    ];
    const right: PolygonRings[] = [
      [
        gridRing(SPEC, [
          [3.0, 0.5],
          [5.5, 0.5],
          [5.5, 2.5],
          [3.0, 2.5],
        ]),
      ],
    ];
    const out = rasterizeDepartments(SPEC, [left, right]);
    for (const j of [1, 2]) {
      for (let i = 1; i <= 2; i++) {
        expect(out[j * SPEC.width + i], `cell ${i},${j}`).toBe(1);
      }
      for (let i = 4; i <= 5; i++) {
        expect(out[j * SPEC.width + i], `cell ${i},${j}`).toBe(2);
      }
      expect(out[j * SPEC.width + 3], `cell 3,${j}`).not.toBe(0);
    }
  });

  it("splits cleanly along a border that falls between cells", () => {
    const left: PolygonRings[] = [
      [
        gridRing(SPEC, [
          [0.5, 0.5],
          [3.5, 0.5],
          [3.5, 2.5],
          [0.5, 2.5],
        ]),
      ],
    ];
    const right: PolygonRings[] = [
      [
        gridRing(SPEC, [
          [3.5, 0.5],
          [5.5, 0.5],
          [5.5, 2.5],
          [3.5, 2.5],
        ]),
      ],
    ];
    const out = rasterizeDepartments(SPEC, [left, right]);
    for (const j of [1, 2]) {
      for (let i = 1; i <= 5; i++) {
        expect(out[j * SPEC.width + i], `cell ${i},${j}`).toBe(i <= 3 ? 1 : 2);
      }
    }
  });
});

describe("majorityDownsampleIndex", () => {
  it("takes the plurality value of each block", () => {
    const src = new Uint8Array([
      5, 5, 0, 0,
      5, 5, 0, 9,
      0, 0, 0, 9,
      0, 2, 0, 9,
    ]);
    const { data, width, height } = majorityDownsampleIndex(src, 4, 4, 2);
    expect(width).toBe(2);
    expect(height).toBe(2);
    // Blocks: {5x4}->5, {0x3,9}->0, {0x3,2}->0, {0x2,9x2}->9 (tie: nonzero).
    expect([...data]).toEqual([5, 0, 0, 9]);
  });

  it("breaks ties toward nonzero, then the lowest index", () => {
    // Block: two 0s vs two 5s -> 5 (inside beats outside on a tie).
    const tie01 = new Uint8Array([5, 5, 0, 0]);
    expect([...majorityDownsampleIndex(tie01, 2, 2, 2).data]).toEqual([5]);
    // Block: 3 vs 5 with equal counts -> lowest index.
    const tie35 = new Uint8Array([5, 5, 3, 3]);
    expect([...majorityDownsampleIndex(tie35, 2, 2, 2).data]).toEqual([3]);
    // All outside stays outside.
    expect([...majorityDownsampleIndex(new Uint8Array(4), 2, 2, 2).data]).toEqual([0]);
  });

  it("handles partial blocks on odd sizes", () => {
    const src = new Uint8Array([
      1, 1, 7,
      1, 1, 7,
      0, 0, 7,
    ]);
    const { data, width, height } = majorityDownsampleIndex(src, 3, 3, 2);
    expect(width).toBe(2);
    expect(height).toBe(2);
    expect([...data]).toEqual([1, 7, 0, 7]);
  });
});

describe("nonzeroCellBounds", () => {
  it("returns inclusive bounds of the nonzero cells", () => {
    const src = new Uint8Array(8 * 8);
    src[2 * 8 + 3] = 1;
    src[5 * 8 + 3] = 1;
    src[4 * 8 + 6] = 2;
    expect(nonzeroCellBounds(src, 8, 8)).toEqual([3, 2, 6, 5]);
  });

  it("returns undefined for an empty raster", () => {
    expect(nonzeroCellBounds(new Uint8Array(16), 4, 4)).toBeUndefined();
  });
});

describe("bbox helpers", () => {
  const a: PolygonRings[] = [
    [
      [
        [-66, -23],
        [-65, -23],
        [-65, -22],
        [-66, -23],
      ],
    ],
  ];
  const b: PolygonRings[] = [
    [
      [
        [-64, -24],
        [-63, -24],
        [-63, -23.5],
        [-64, -24],
      ],
    ],
  ];

  it("polygonsBBox gives [west, south, east, north]", () => {
    expect(polygonsBBox(a)).toEqual([-66, -23, -65, -22]);
  });

  it("unionBBox merges several polygon sets", () => {
    expect(unionBBox([a, b])).toEqual([-66, -24, -63, -22]);
  });

  it("vertexCentroid averages every vertex", () => {
    const [lon, lat] = vertexCentroid(a);
    expect(lon).toBeCloseTo((-66 - 65 - 65 - 66) / 4, 10);
    expect(lat).toBeCloseTo((-23 - 23 - 22 - 23) / 4, 10);
  });

  it("bboxContainsPoint is inclusive on the edges", () => {
    const bbox: readonly [number, number, number, number] = [-66, -23, -65, -22];
    expect(bboxContainsPoint(bbox, -65.5, -22.5)).toBe(true);
    expect(bboxContainsPoint(bbox, -66, -22)).toBe(true);
    expect(bboxContainsPoint(bbox, -67, -22.5)).toBe(false);
    expect(bboxContainsPoint(bbox, -65.5, -21)).toBe(false);
  });
});
