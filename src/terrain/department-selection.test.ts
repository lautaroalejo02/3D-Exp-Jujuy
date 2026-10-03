import { describe, expect, it } from "vitest";

import {
  connectedComponents,
  selectJujuyDepartments,
} from "./department-selection";
import {
  JUJUY_DEPARTMENT_NAMES,
  normalizeDepartmentName,
  type BBoxLonLat,
  type GeoJsonFeature,
  type PolygonRings,
} from "./raster-vector";

/** Covers the whole province with room to spare, like the real DEM extent. */
const EXTENT: BBoxLonLat = [-68, -25, -63, -21];

/**
 * The verbatim shapeNames the source carries — accents included, unlike
 * the brief's checklist.
 */
const VERBATIM_NAMES: readonly string[] = [
  "Yaví",
  "Santa Catalina",
  "Rinconada",
  "Cochinoca",
  "Susques",
  "Humahuaca",
  "Tilcara",
  "Tumbaya",
  "Dr. Manuel Belgrano",
  "Palpalá",
  "El Carmen",
  "San Antonio",
  "Ledesma",
  "San Pedro",
  "Santa Bárbara",
  "Valle Grande",
];

function squareFeature(
  name: string,
  west: number,
  south: number,
  size = 0.5,
): GeoJsonFeature {
  return {
    type: "Feature",
    properties: {
      shapeName: name,
      shapeISO: "",
      shapeID: `id-${name}-${west}-${south}`,
      shapeGroup: "ARG",
      shapeType: "ADM2",
    },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [west, south],
          [west + size, south],
          [west + size, south + size],
          [west, south + size],
          [west, south],
        ],
      ],
    },
  };
}

/**
 * Sixteen edge-adjacent squares inside EXTENT, named with the source's
 * verbatim names — a miniature of the real collection.
 */
function miniatureJujuy(): GeoJsonFeature[] {
  return VERBATIM_NAMES.map((name, k) =>
    squareFeature(name, -66 + (k % 4) * 0.5, -24 + Math.floor(k / 4) * 0.5),
  );
}

describe("selectJujuyDepartments", () => {
  it("returns one Adm2Feature per expected name with verbatim names", () => {
    const selected = selectJujuyDepartments(miniatureJujuy(), EXTENT);
    expect(selected).toHaveLength(JUJUY_DEPARTMENT_NAMES.length);
    const keys = new Set(selected.map((d) => d.nameKey));
    for (const expected of JUJUY_DEPARTMENT_NAMES) {
      expect(keys.has(normalizeDepartmentName(expected))).toBe(true);
    }
    // Published names are the source's verbatim shapeName.
    const names = selected.map((d) => d.sourceName);
    expect(names).toContain("Yaví");
    expect(names).not.toContain("Yavi");
  });

  it("ignores a same-named department outside the DEM extent", () => {
    // The real file has three "San Pedro"; the one inside Jujuy's extent
    // must win and the outside ones must not make the match ambiguous.
    const features = [
      ...miniatureJujuy(),
      squareFeature("San Pedro", -70, -30), // Mendoza, outside EXTENT
      squareFeature("San Pedro", -60, -27), // also outside
    ];
    const selected = selectJujuyDepartments(features, EXTENT);
    expect(selected).toHaveLength(16);
    const sanPedro = selected.filter((d) => d.sourceName === "San Pedro");
    expect(sanPedro).toHaveLength(1);
  });

  it("fails listing every missing department", () => {
    const features = miniatureJujuy().filter(
      (f) => f.properties?.shapeName !== "Susques",
    );
    expect(() => selectJujuyDepartments(features, EXTENT)).toThrow(
      /missing department "Susques"/,
    );
  });

  it("fails when a name matches twice inside the extent", () => {
    const features = [
      ...miniatureJujuy(),
      squareFeature("San Pedro", -67, -22), // inside EXTENT: ambiguous
    ];
    expect(() => selectJujuyDepartments(features, EXTENT)).toThrow(
      /"San Pedro" matched 2 features/,
    );
  });
});

describe("connectedComponents", () => {
  it("counts the 16 adjacent departments as a single component", () => {
    const selected = selectJujuyDepartments(miniatureJujuy(), EXTENT);
    expect(connectedComponents(selected.map((d) => d.polygons))).toBe(1);
  });

  it("counts an isolated department as a second component", () => {
    const selected = selectJujuyDepartments(miniatureJujuy(), EXTENT);
    const farAway: readonly PolygonRings[] = [
      [
        [
          [-70, -30],
          [-69.5, -30],
          [-69.5, -29.5],
          [-70, -29.5],
          [-70, -30],
        ],
      ],
    ];
    expect(
      connectedComponents([...selected.map((d) => d.polygons), farAway]),
    ).toBe(2);
  });
});
