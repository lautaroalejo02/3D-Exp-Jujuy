/**
 * Region data for Jujuy's four regions, hand-authored in
 * data/raw/regions-jujuy.json from the verified PIP Jujuy source (see
 * odd/research/pip-jujuy-extracto.txt — every quote field is verbatim).
 *
 * Pure data access — nothing here touches the GPU or the DOM. The terrain
 * layer consumes buildRegionOverlay's RGBA raster through the shader's
 * overlay slot; the pick panel consumes departmentIndexAt.
 */
import {
  DEPARTMENT_COUNT,
  type DepartmentInfo,
} from "./departments";

export const REGIONS_SCHEMA_VERSION = 1;
export const REGION_COUNT = 4;

/** Thrown when regions-jujuy.json fails validation. */
export class RegionsDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegionsDataError";
  }
}

export type RegionId = "puna" | "quebrada" | "valles" | "yungas";
export const REGION_IDS: readonly RegionId[] = [
  "puna",
  "quebrada",
  "valles",
  "yungas",
];

export interface RegionDescription {
  /**
   * 1–2 sentences for the region card: verbatim or a close paraphrase of
   * the extract, with no numbers absent from it.
   */
  readonly text: string;
  /** Verbatim source passage `text` is based on. */
  readonly quote: string;
}

export interface Region {
  readonly id: RegionId;
  /** Display name; the source's "Ramal" is shown as "Yungas (Ramal)". */
  readonly name: string;
  /**
   * Department names verbatim from the geoBoundaries source (e.g.
   * "Yaví"), exactly as departments.json lists them.
   */
  readonly departments: readonly string[];
  /** Verbatim sentence that lists the region's departments. */
  readonly quote: string;
  /** Verbatim caveat from the source, when it has one. */
  readonly nuance?: string;
  readonly description: RegionDescription;
}

export interface RegionsSource {
  readonly title: string;
  readonly publisher: string;
  readonly url: string;
}

export interface RegionsData {
  readonly schemaVersion: number;
  readonly source: RegionsSource;
  readonly regions: readonly Region[];
}

/**
 * Okabe–Ito colorblind-safe tints, chosen to stay readable over the
 * satellite image: orange on the Puna's tan altiplano, blue on the
 * Quebrada's red-brown canyon, purple on the Valles farmland and green on
 * the Yungas jungle. `rgb` feeds the overlay texture, `css` the legend.
 */
export const REGION_COLORS: Record<
  RegionId,
  { readonly css: string; readonly rgb: readonly [number, number, number] }
> = {
  puna: { css: "#e69f00", rgb: [230, 159, 0] },
  quebrada: { css: "#0072b2", rgb: [0, 114, 178] },
  valles: { css: "#cc79a7", rgb: [204, 121, 167] },
  yungas: { css: "#009e73", rgb: [0, 158, 115] },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RegionsDataError(`regions-jujuy.json: ${field} is not a string`);
  }
}

/**
 * Validate the parsed regions-jujuy.json. Text fields are not re-checked
 * against the extract here — regions.test.ts asserts verbatim quotes.
 */
export function parseRegions(value: unknown): RegionsData {
  if (!isRecord(value) || value.schemaVersion !== REGIONS_SCHEMA_VERSION) {
    throw new RegionsDataError(
      `regions-jujuy.json is missing or does not match schema version ` +
        REGIONS_SCHEMA_VERSION,
    );
  }
  if (!isRecord(value.source)) {
    throw new RegionsDataError("regions-jujuy.json has no source object");
  }
  for (const field of ["title", "publisher", "url"] as const) {
    assertString(value.source[field], `source.${field}`);
  }
  if (!Array.isArray(value.regions)) {
    throw new RegionsDataError("regions-jujuy.json has no regions array");
  }
  const regions = value.regions as unknown[];
  if (regions.length !== REGION_COUNT) {
    throw new RegionsDataError(
      `regions-jujuy.json lists ${regions.length} regions, ` +
        `expected ${REGION_COUNT}`,
    );
  }
  const seenIds = new Set<string>();
  for (const [k, r] of regions.entries()) {
    if (!isRecord(r)) {
      throw new RegionsDataError(`regions entry ${k} is not an object`);
    }
    if (typeof r.id !== "string" || !REGION_IDS.includes(r.id as RegionId)) {
      throw new RegionsDataError(`regions entry ${k} has an unknown id`);
    }
    if (seenIds.has(r.id)) {
      throw new RegionsDataError(`regions entry ${k} duplicates id ${r.id}`);
    }
    seenIds.add(r.id);
    assertString(r.name, `regions[${k}].name`);
    assertString(r.quote, `regions[${k}].quote`);
    if (r.nuance !== undefined) {
      assertString(r.nuance, `regions[${k}].nuance`);
    }
    if (!Array.isArray(r.departments)) {
      throw new RegionsDataError(`regions[${k}].departments is not an array`);
    }
    for (const name of r.departments as unknown[]) {
      assertString(name, `regions[${k}].departments[]`);
    }
    if (!isRecord(r.description)) {
      throw new RegionsDataError(`regions[${k}].description is missing`);
    }
    assertString(r.description.text, `regions[${k}].description.text`);
    assertString(r.description.quote, `regions[${k}].description.quote`);
  }
  // Every field was just validated above; Record<string, unknown> needs
  // the double cast to narrow into the interface.
  return value as unknown as RegionsData;
}

/**
 * Region index (position in data.regions) per department raster value:
 * element 0 is -1 (0 = outside the province), elements 1..16 map each
 * department to its region. Throws when a region names a department
 * absent from departments.json, when one is assigned to two regions, or
 * when an in-province department is left without a region — the shader
 * and the pick panel assume complete coverage.
 */
export function buildDepartmentToRegion(
  data: RegionsData,
  departments: readonly DepartmentInfo[],
): readonly number[] {
  const indexByName = new Map(departments.map((d) => [d.name, d.index]));
  const lut = new Array<number>(DEPARTMENT_COUNT + 1).fill(-1);
  for (const [regionIndex, region] of data.regions.entries()) {
    for (const name of region.departments) {
      const deptIndex = indexByName.get(name);
      if (deptIndex === undefined) {
        throw new RegionsDataError(
          `regions-jujuy.json: ${region.id} lists department "${name}", ` +
            `which is not in departments.json`,
        );
      }
      if (lut[deptIndex] !== -1) {
        throw new RegionsDataError(
          `regions-jujuy.json: "${name}" is assigned to more than one region`,
        );
      }
      lut[deptIndex] = regionIndex;
    }
  }
  // Every in-province department must land in exactly one region; a slot
  // still at -1 means regions-jujuy.json forgot it.
  const missing = departments.filter((d) => lut[d.index] === -1);
  if (missing.length > 0) {
    throw new RegionsDataError(
      `regions-jujuy.json leaves department(s) without a region: ` +
        missing.map((d) => `"${d.name}"`).join(", "),
    );
  }
  return lut;
}

/**
 * Region display name per department raster value (element 0 = outside),
 * for the pick panel's "Región" row.
 */
export function departmentToRegionNames(
  lut: readonly number[],
  data: RegionsData,
): readonly (string | undefined)[] {
  return lut.map((i) => (i >= 0 ? data.regions[i]?.name : undefined));
}

/**
 * Region tint for the shader's overlay slot: one RGBA pixel per department
 * raster cell — the region color with alpha 255 inside the province,
 * fully transparent outside. The shader's overlayOpacity uniform is the
 * tint strength.
 */
export function buildRegionOverlay(
  index: Uint8Array,
  deptToRegion: readonly number[],
  data: RegionsData,
): Uint8Array {
  const rgba = new Uint8Array(index.length * 4);
  for (let k = 0; k < index.length; k++) {
    const regionIndex = deptToRegion[index[k] ?? 0] ?? -1;
    const region = regionIndex >= 0 ? data.regions[regionIndex] : undefined;
    if (!region) continue;
    const [r, g, b] = REGION_COLORS[region.id].rgb;
    rgba[k * 4] = r;
    rgba[k * 4 + 1] = g;
    rgba[k * 4 + 2] = b;
    rgba[k * 4 + 3] = 255;
  }
  return rgba;
}

/**
 * Department raster value at fractional grid coordinates (cell centers at
 * integer coords), or 0 — outside the province — when the coords fall off
 * the raster. Same convention as departmentNameAt.
 */
export function departmentIndexAt(
  data: {
    readonly grid: { readonly width: number; readonly height: number };
    readonly index: Uint8Array;
  },
  i: number,
  j: number,
): number {
  const ci = Math.round(i);
  const cj = Math.round(j);
  if (
    ci < 0 ||
    cj < 0 ||
    ci >= data.grid.width ||
    cj >= data.grid.height
  ) {
    return 0;
  }
  return data.index[cj * data.grid.width + ci] ?? 0;
}
