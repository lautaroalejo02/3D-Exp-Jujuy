import { describe, expect, it } from "vitest";

import type { DepartmentInfo } from "../../terrain/departments";
import {
  OUTSIDE_JUJUY,
  UNASSIGNED_REGION,
} from "../../ui/pick-panel";
import {
  placeRegionLabel,
  regionSourceLabel,
  type PlaceRegionLookup,
} from "./place-region";

const LOOKUP: PlaceRegionLookup = {
  departments: [
    { index: 1, name: "Humahuaca" },
    { index: 2, name: "Tilcara" },
    { index: 3, name: "Ledesma" },
  ] satisfies readonly DepartmentInfo[],
  regionNames: [
    undefined, // raster value 0 = outside the province
    "Quebrada", // Humahuaca
    "Quebrada", // Tilcara
    undefined, // Ledesma — in province, but no region in the LUT
  ],
  source: {
    title:
      "PIP Jujuy — Programa de Inclusión Socio-Económica en Áreas Rurales (PISEAR)",
    publisher: "Ministerio de Agroindustria de la Nación",
    url: "https://example.test/pip-jujuy.pdf",
  },
};

describe("placeRegionLabel", () => {
  it("maps a department name to its region", () => {
    expect(placeRegionLabel("Humahuaca", LOOKUP)).toBe("Quebrada");
    expect(placeRegionLabel("Tilcara", LOOKUP)).toBe("Quebrada");
  });

  it("reports Fuera de Jujuy when the name is not a department", () => {
    // places.json stores the literal OUTSIDE_JUJUY for out-of-province
    // places; any other unknown name resolves to raster index 0 too.
    expect(placeRegionLabel(OUTSIDE_JUJUY, LOOKUP)).toBe(OUTSIDE_JUJUY);
    expect(placeRegionLabel("Departamento inventado", LOOKUP)).toBe(
      OUTSIDE_JUJUY,
    );
  });

  it("reports Sin región asignada for an in-province department with no region", () => {
    expect(placeRegionLabel("Ledesma", LOOKUP)).toBe(UNASSIGNED_REGION);
  });
});

describe("regionSourceLabel", () => {
  it("credits the source with its short title and publisher", () => {
    // The card links this text to source.url — nothing is hard-coded.
    expect(regionSourceLabel(LOOKUP.source)).toBe(
      "PIP Jujuy (Ministerio de Agroindustria de la Nación)",
    );
  });

  it("keeps the full title when it has no em-dash", () => {
    expect(
      regionSourceLabel({
        title: "Atlas provincial",
        publisher: "Editorial",
        url: "https://example.test/atlas",
      }),
    ).toBe("Atlas provincial (Editorial)");
  });
});
