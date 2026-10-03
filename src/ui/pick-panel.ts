import type { Layer, PickHit } from "../app/layers";
import {
  globalPixelToGrid,
  gridToGlobalPixel,
  type GridSpec,
} from "../geo/grid";
import {
  departmentNameAt,
  type DepartmentsData,
} from "../terrain/departments";
import { departmentIndexAt } from "../terrain/regions";

/**
 * Pick info panel: shows the latitude, longitude and DEM elevation of the
 * point the user tapped. All text is Argentine Spanish aimed at high-school
 * students; numbers use the Spanish decimal comma and the "." thousands
 * separator.
 *
 * The panel is a DOM-only Layer: init/update/draw are no-ops, the element
 * mounts through `ui` (so the headless snapshot renderer never touches the
 * DOM) and `onPick` fills it — the same extension point real map features
 * will use.
 */

/** Precision facts derived from the loaded data, never hand-written. */
export interface PickPanelPrecision {
  /** Ground meters covered by one height-grid cell at the loaded quality. */
  readonly cellSizeMeters: number;
  /**
   * Mean reconstruction error of the downsampled level, when the manifest
   * reports one (default quality only).
   */
  readonly meanAbsErrorMeters?: number;
}

/** "23,2054° S" — decimal degrees with 4 decimals, hemisphere letter. */
export function formatLatitude(lat: number): string {
  return `${Math.abs(lat).toFixed(4).replace(".", ",")}° ${lat >= 0 ? "N" : "S"}`;
}

/** "65,3505° O" — decimal degrees with 4 decimals, hemisphere letter. */
export function formatLongitude(lon: number): string {
  return `${Math.abs(lon).toFixed(4).replace(".", ",")}° ${lon >= 0 ? "E" : "O"}`;
}

/** "2.939 m s. n. m." — meters above sea level, rounded to the meter. */
export function formatElevation(meters: number): string {
  const rounded = Math.round(meters);
  const digits = String(Math.abs(rounded)).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ".",
  );
  return `${rounded < 0 ? "-" : ""}${digits} m s. n. m.`;
}

/** "Dato del modelo de elevación (celdas de ~305 m · ±~7 m en promedio)" */
export function precisionNote(precision: PickPanelPrecision): string {
  const parts = [`celdas de ~${Math.round(precision.cellSizeMeters)} m`];
  if (precision.meanAbsErrorMeters !== undefined) {
    parts.push(`±~${Math.round(precision.meanAbsErrorMeters)} m en promedio`);
  }
  return `Dato del modelo de elevación (${parts.join(" · ")})`;
}

/** What the department row shows when the index raster reads 0. */
export const OUTSIDE_JUJUY = "Fuera de Jujuy";

/** What the region row shows for an in-province cell with no region. */
export const UNASSIGNED_REGION = "Sin región asignada";

/**
 * Region label for a department raster value. "Fuera de Jujuy" only when
 * the raster reads 0: an in-province index without a region means the
 * regions data is incomplete, not that the point is outside Jujuy.
 */
export function regionLabel(
  regionNames: readonly (string | undefined)[],
  deptIndex: number,
): string {
  if (deptIndex === 0) return OUTSIDE_JUJUY;
  return regionNames[deptIndex] ?? UNASSIGNED_REGION;
}

/**
 * Department raster for the "Departamento" row. `data` is the loaded
 * boundary dataset; `hitSpec` is the grid `PickHit.grid` coordinates are
 * expressed in (the height grid) — the raster covers the same ground
 * extent, so the conversion is a pixel-space round trip.
 */
export interface PickPanelDepartments {
  readonly data: DepartmentsData;
  readonly hitSpec: GridSpec;
  /**
   * Region display name per department raster value (element 0 =
   * outside), from departmentToRegionNames — adds the "Región" row.
   */
  readonly regionNames?: readonly (string | undefined)[];
}

const MISS_HINT = "Tocá o hacé clic sobre el relieve";

export function createPickPanelLayer(
  precision: PickPanelPrecision,
  departments?: PickPanelDepartments,
): Layer {
  interface PanelEls {
    readonly panel: HTMLElement;
    readonly lat: HTMLElement;
    readonly lon: HTMLElement;
    readonly alt: HTMLElement;
    readonly dept: HTMLElement | undefined;
    readonly region: HTMLElement | undefined;
    readonly dataRows: HTMLElement;
    readonly note: HTMLElement;
    readonly hint: HTMLElement;
  }
  let els: PanelEls | undefined;

  const showHit = (hit: PickHit): void => {
    if (!els) return;
    els.lat.textContent = formatLatitude(hit.lonLat[1]);
    els.lon.textContent = formatLongitude(hit.lonLat[0]);
    els.alt.textContent = formatElevation(hit.elevationMeters);
    if (els.dept && departments) {
      const [px, py] = gridToGlobalPixel(
        departments.hitSpec,
        hit.grid[0],
        hit.grid[1],
      );
      const [di, dj] = globalPixelToGrid(departments.data.grid, px, py);
      els.dept.textContent =
        departmentNameAt(departments.data, di, dj) ?? OUTSIDE_JUJUY;
      if (els.region && departments.regionNames) {
        const deptIndex = departmentIndexAt(departments.data, di, dj);
        els.region.textContent = regionLabel(
          departments.regionNames,
          deptIndex,
        );
      }
    }
    els.dataRows.hidden = false;
    els.note.hidden = false;
    els.hint.hidden = true;
    els.panel.hidden = false;
  };

  const showMiss = (): void => {
    if (!els) return;
    els.dataRows.hidden = true;
    els.note.hidden = true;
    els.hint.hidden = false;
    els.panel.hidden = false;
  };

  return {
    id: "pick-panel",
    init(): void {},
    update(): void {},
    draw(): void {},
    onPick(hit: PickHit | undefined): void {
      if (hit) showHit(hit);
      else showMiss();
    },
    ui: {
      mount(root: HTMLElement): () => void {
        const doc = root.ownerDocument;
        const panel = doc.createElement("section");
        panel.className = "pick-panel";
        panel.hidden = true;
        panel.setAttribute("aria-live", "polite");

        const close = doc.createElement("button");
        close.type = "button";
        close.className = "pick-panel-close";
        close.textContent = "×";
        close.setAttribute("aria-label", "Cerrar");

        const dataRows = doc.createElement("dl");
        dataRows.className = "pick-panel-data";
        const row = (label: string): HTMLElement => {
          const dt = doc.createElement("dt");
          dt.textContent = label;
          const dd = doc.createElement("dd");
          dataRows.append(dt, dd);
          return dd;
        };
        const lat = row("Latitud");
        const lon = row("Longitud");
        const alt = row("Altura");
        const dept = departments ? row("Departamento") : undefined;
        const region = departments?.regionNames ? row("Región") : undefined;

        const note = doc.createElement("p");
        note.className = "pick-panel-note";
        note.textContent = precisionNote(precision);

        const hint = doc.createElement("p");
        hint.className = "pick-panel-hint";
        hint.textContent = MISS_HINT;
        hint.hidden = true;

        close.addEventListener("click", () => {
          panel.hidden = true;
        });

        panel.append(close, dataRows, note, hint);
        root.appendChild(panel);
        els = { panel, lat, lon, alt, dept, region, dataRows, note, hint };
        return () => {
          els = undefined;
          panel.remove();
        };
      },
    },
  };
}
