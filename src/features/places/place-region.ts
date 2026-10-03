/**
 * "Región" row for the place card. The card only stores the department
 * NAME in places.json (verbatim from geoBoundaries), so it is resolved
 * back to its raster index through departments.json and then through the
 * same regionNames LUT the pick panel uses (regionLabel's contract:
 * index 0 → "Fuera de Jujuy", an in-province department without a region
 * → "Sin región asignada"). Pure — no DOM, no GPU.
 */
import type { DepartmentInfo } from "../../terrain/departments";
import type { RegionsSource } from "../../terrain/regions";
import { regionLabel } from "../../ui/pick-panel";

/** Inputs the card needs to resolve a place's region. */
export interface PlaceRegionLookup {
  /** departments.json entries (index is the department raster value). */
  readonly departments: readonly DepartmentInfo[];
  /** Region display name per department raster value (element 0 unused). */
  readonly regionNames: readonly (string | undefined)[];
  /**
   * The regions dataset's source (regions-jujuy.json `source`), so the
   * card's "Región" credit can link to it instead of naming it in
   * hard-coded text.
   */
  readonly source: RegionsSource;
}

/**
 * Short credit text for the region source link: the title up to the
 * first em-dash plus the publisher — "PIP Jujuy (Ministerio de …)".
 */
export function regionSourceLabel(source: RegionsSource): string {
  return `${source.title.replace(/\s*—.*$/, "")} (${source.publisher})`;
}

/**
 * Region display name for a place's `department` field. A name the
 * boundary data does not list — including the stored "Fuera de Jujuy" —
 * is index 0 and renders as outside the province.
 */
export function placeRegionLabel(
  departmentName: string,
  lookup: PlaceRegionLookup,
): string {
  const index =
    lookup.departments.find((d) => d.name === departmentName)?.index ?? 0;
  return regionLabel(lookup.regionNames, index);
}
