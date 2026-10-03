import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { DepartmentInfo } from "./departments";
import {
  buildDepartmentToRegion,
  buildRegionOverlay,
  departmentIndexAt,
  parseRegions,
  REGION_COLORS,
  RegionsDataError,
  REGIONS_SCHEMA_VERSION,
} from "./regions";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const rawJson: unknown = JSON.parse(
  readFileSync(join(ROOT, "data", "raw", "regions-jujuy.json"), "utf8"),
);
const extract = readFileSync(
  join(ROOT, "odd", "research", "pip-jujuy-extracto.txt"),
  "utf8",
);

interface GeoJsonLike {
  features: { properties: { shapeName: string } }[];
}
const geojson = JSON.parse(
  readFileSync(
    join(ROOT, "data", "raw", "geoBoundaries-ARG-ADM2-jujuy.geojson"),
    "utf8",
  ),
) as GeoJsonLike;
const sourceNames = geojson.features
  .map((f) => f.properties.shapeName)
  .sort((a, b) => a.localeCompare(b));

/** pdftotext line breaks are layout artifacts, so only whitespace differs. */
const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
const normalizedExtract = collapse(extract);

describe("regions-jujuy.json", () => {
  const data = parseRegions(rawJson);

  it("declares the schema version and the PIP Jujuy source", () => {
    expect(data.schemaVersion).toBe(REGIONS_SCHEMA_VERSION);
    expect(data.source.url).toContain("PIP%20Jujuy.pdf");
    expect(data.source.publisher).toContain("Ministerio de Agroindustria");
  });

  it("has the four regions with the expected ids and names", () => {
    expect(data.regions.map((r) => r.id)).toEqual([
      "puna",
      "quebrada",
      "valles",
      "yungas",
    ]);
    expect(data.regions.map((r) => r.name)).toEqual([
      "Puna",
      "Quebrada",
      "Valles",
      "Yungas (Ramal)",
    ]);
  });

  it("assigns all 16 geoBoundaries departments exactly once", () => {
    const assigned = data.regions
      .flatMap((r) => r.departments)
      .sort((a, b) => a.localeCompare(b));
    expect(assigned).toEqual(sourceNames);
    expect(assigned).toHaveLength(16);
  });

  it("keeps every quote verbatim in the PIP Jujuy extract", () => {
    for (const region of data.regions) {
      expect(
        normalizedExtract,
        `${region.id} department-list quote`,
      ).toContain(collapse(region.quote));
      expect(
        normalizedExtract,
        `${region.id} description quote`,
      ).toContain(collapse(region.description.quote));
      if (region.nuance !== undefined) {
        expect(normalizedExtract, `${region.id} nuance`).toContain(
          collapse(region.nuance),
        );
      }
    }
  });

  it("rejects a file with the wrong schema version", () => {
    expect(() =>
      parseRegions({ ...(rawJson as object), schemaVersion: 99 }),
    ).toThrow(RegionsDataError);
  });
});

describe("department → region mapping", () => {
  const data = parseRegions(rawJson);
  // The pipeline assigns indices alphabetically by normalized source name.
  const departments: readonly DepartmentInfo[] = sourceNames.map(
    (name, k) => ({ index: k + 1, name }),
  );
  const lut = buildDepartmentToRegion(data, departments);

  it("maps every department index to a region, 0 stays unassigned", () => {
    expect(lut).toHaveLength(17);
    expect(lut[0]).toBe(-1);
    for (const dept of departments) {
      expect(lut[dept.index], dept.name).toBeGreaterThanOrEqual(0);
      expect(lut[dept.index], dept.name).toBeLessThan(data.regions.length);
    }
  });

  it("puts Humahuaca in Quebrada (the Puna nuance is not an assignment)", () => {
    const humahuaca = departments.find((d) => d.name === "Humahuaca");
    const quebradaIndex = data.regions.findIndex((r) => r.id === "quebrada");
    expect(lut[humahuaca!.index]).toBe(quebradaIndex);
  });

  it("throws when a region lists a department the boundaries lack", () => {
    const broken = {
      ...data,
      regions: [
        {
          ...data.regions[0]!,
          departments: ["Nombre Inventado"],
        },
        ...data.regions.slice(1),
      ],
    };
    expect(() => buildDepartmentToRegion(broken, departments)).toThrow(
      RegionsDataError,
    );
  });

  it("throws naming the department assigned to two regions", () => {
    const duplicated = {
      ...data,
      regions: [
        {
          ...data.regions[0]!,
          departments: [...data.regions[0]!.departments, "Humahuaca"],
        },
        ...data.regions.slice(1),
      ],
    };
    const call = (): readonly number[] =>
      buildDepartmentToRegion(duplicated, departments);
    expect(call).toThrow(RegionsDataError);
    expect(call).toThrow(/Humahuaca/);
  });

  it("throws naming every department left without a region", () => {
    const incomplete = {
      ...data,
      regions: data.regions.map((r) => ({
        ...r,
        departments: r.departments.filter(
          (n) => n !== "Humahuaca" && n !== "Yaví",
        ),
      })),
    };
    const call = (): readonly number[] =>
      buildDepartmentToRegion(incomplete, departments);
    expect(call).toThrow(RegionsDataError);
    expect(call).toThrow(/Humahuaca/);
    expect(call).toThrow(/Yaví/);
  });
});

describe("region overlay and lookups", () => {
  const data = parseRegions(rawJson);
  const departments: readonly DepartmentInfo[] = sourceNames.map(
    (name, k) => ({ index: k + 1, name }),
  );
  const lut = buildDepartmentToRegion(data, departments);
  const indexOf = (name: string): number =>
    departments.find((d) => d.name === name)!.index;

  it("paints region RGBA where the raster is inside the province", () => {
    const raster = new Uint8Array([
      0,
      indexOf("Yaví"),
      indexOf("Tumbaya"),
      indexOf("Ledesma"),
      indexOf("Palpalá"),
    ]);
    const rgba = buildRegionOverlay(raster, lut, data);
    expect(rgba).toHaveLength(raster.length * 4);
    // Outside cell: fully transparent.
    expect(Array.from(rgba.slice(0, 4))).toEqual([0, 0, 0, 0]);
    const expectRegion = (
      cell: number,
      id: keyof typeof REGION_COLORS,
    ): void => {
      const [r, g, b] = REGION_COLORS[id].rgb;
      expect(Array.from(rgba.slice(cell * 4, cell * 4 + 4))).toEqual([
        r,
        g,
        b,
        255,
      ]);
    };
    expectRegion(1, "puna");
    expectRegion(2, "quebrada");
    expectRegion(3, "yungas");
    expectRegion(4, "valles");
  });

  it("reads the department index at grid coords like departmentNameAt", () => {
    const grid = { width: 4, height: 2 };
    const raster = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const data2 = { grid, index: raster };
    expect(departmentIndexAt(data2, 1.2, 0.1)).toBe(1);
    expect(departmentIndexAt(data2, 3.4, 1.2)).toBe(7);
    expect(departmentIndexAt(data2, -1, 0)).toBe(0);
    expect(departmentIndexAt(data2, 99, 0)).toBe(0);
  });
});
