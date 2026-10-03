/**
 * Explorar mode content: a place search + list (tap flies the camera and
 * opens the place card), the "Mostrar lugares" switch, and the sections
 * the caller appends below — Regiones, terrain controls and the "Fuentes
 * de datos" attributions. Text is Argentine Spanish for high-school
 * students.
 */
import type { Place } from "../terrain/places-manifest";
import { filterPlacesByName } from "../features/places/place-search";

export interface ExplorarContentOptions {
  readonly places: readonly Place[];
  /** A place was tapped in the list: fly the camera + open its card. */
  readonly onSelectPlace: (place: Place) => void;
  /** The "Mostrar lugares" switch flipped (markers on/off). */
  readonly onPlacesVisible: (visible: boolean) => void;
  /**
   * Sections appended after the built-ins, in order — the Regiones
   * panel, the terrain controls and the attributions section.
   */
  readonly sections?: readonly HTMLElement[];
}

export function createExplorarContent(
  opts: ExplorarContentOptions,
  doc: Document = document,
): HTMLElement {
  const root = doc.createElement("div");
  root.className = "explorar";

  const search = doc.createElement("input");
  search.type = "search";
  search.className = "explorar-search";
  search.placeholder = "Buscar lugar…";
  search.setAttribute("aria-label", "Buscar lugar");

  const list = doc.createElement("ul");
  list.className = "explorar-places";

  const empty = doc.createElement("p");
  empty.className = "explorar-empty";
  empty.hidden = true;

  const sorted = [...opts.places].sort((a, b) =>
    a.name.localeCompare(b.name, "es"),
  );

  const renderList = (): void => {
    const matches = filterPlacesByName(sorted, search.value);
    list.textContent = "";
    for (const place of matches) {
      const li = doc.createElement("li");
      const item = doc.createElement("button");
      item.type = "button";
      item.className = "explorar-places-item";
      const name = doc.createElement("span");
      name.className = "explorar-places-name";
      name.textContent = place.name;
      const dept = doc.createElement("span");
      dept.className = "explorar-places-dept";
      dept.textContent = place.department;
      item.append(name, dept);
      item.addEventListener("click", () => {
        opts.onSelectPlace(place);
      });
      li.appendChild(item);
      list.appendChild(li);
    }
    empty.hidden = matches.length > 0;
    if (matches.length === 0) {
      empty.textContent = `Sin resultados para «${search.value.trim()}»`;
    }
  };
  renderList();
  search.addEventListener("input", renderList);

  const visible = doc.createElement("label");
  visible.className = "regions-toggle explorar-places-visible";
  const checkbox = doc.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = true;
  checkbox.addEventListener("change", () => {
    opts.onPlacesVisible(checkbox.checked);
  });
  const visibleText = doc.createElement("span");
  visibleText.textContent = "Mostrar lugares";
  visible.append(checkbox, visibleText);

  root.append(search, list, empty, visible, ...(opts.sections ?? []));
  return root;
}
