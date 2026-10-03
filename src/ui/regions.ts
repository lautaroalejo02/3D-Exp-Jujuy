/**
 * "Regiones" UI: a large pill switch (off by default, the satellite view
 * is the default), a dismissible legend while the layer is on — an ×
 * closes it and a "Leyenda" pill brings it back — and a small card per
 * region with its sourced description, the source's nuance (if any) as
 * "Nota: …" and the PIP Jujuy source link. Text is Argentine Spanish
 * for high-school students.
 */
import {
  REGION_COLORS,
  type Region,
  type RegionsSource,
} from "../terrain/regions";

export interface RegionsControlsOptions {
  readonly regions: readonly Region[];
  readonly source: RegionsSource;
  /** Called when the checkbox flips; the caller triggers a re-render. */
  readonly onToggle: (on: boolean) => void;
  /** Start checked; default off. */
  readonly initiallyOn?: boolean;
}

export function createRegionsControls(
  opts: RegionsControlsOptions,
  doc: Document = document,
): HTMLElement {
  const panel = doc.createElement("section");
  panel.className = "regions-controls";

  const toggleLabel = doc.createElement("label");
  toggleLabel.className = "regions-toggle";
  const checkbox = doc.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = opts.initiallyOn ?? false;
  const toggleText = doc.createElement("span");
  toggleText.textContent = "Regiones";
  toggleLabel.append(checkbox, toggleText);

  // The legend is dismissible on its own: the × closes it while the
  // regions stay on, and a small "Leyenda" pill brings it back. Flipping
  // the switch off and on also restores it.
  let legendDismissed = false;

  const legend = doc.createElement("div");
  legend.className = "regions-legend";

  const legendHead = doc.createElement("div");
  legendHead.className = "regions-legend-head";
  const legendTitle = doc.createElement("span");
  legendTitle.className = "regions-legend-title";
  legendTitle.textContent = "Leyenda";
  const legendClose = doc.createElement("button");
  legendClose.type = "button";
  legendClose.className = "regions-legend-close";
  legendClose.textContent = "×";
  legendClose.setAttribute("aria-label", "Cerrar la leyenda");
  legendHead.append(legendTitle, legendClose);

  const legendItems = doc.createElement("ul");
  legendItems.className = "regions-legend-items";
  legend.append(legendHead, legendItems);

  const legendReopen = doc.createElement("button");
  legendReopen.type = "button";
  legendReopen.className = "regions-legend-reopen";
  legendReopen.textContent = "Leyenda";

  const renderLegend = (): void => {
    legend.hidden = !checkbox.checked || legendDismissed;
    legendReopen.hidden = !checkbox.checked || !legendDismissed;
  };
  legendClose.addEventListener("click", () => {
    legendDismissed = true;
    renderLegend();
  });
  legendReopen.addEventListener("click", () => {
    legendDismissed = false;
    renderLegend();
  });

  const card = doc.createElement("article");
  card.className = "region-card";
  card.hidden = true;

  const cardClose = doc.createElement("button");
  cardClose.type = "button";
  cardClose.className = "region-card-close";
  cardClose.textContent = "×";
  cardClose.setAttribute("aria-label", "Cerrar");
  cardClose.addEventListener("click", () => {
    card.hidden = true;
  });

  const cardTitle = doc.createElement("h3");
  const cardDepartments = doc.createElement("p");
  cardDepartments.className = "region-card-departments";
  const cardText = doc.createElement("p");
  cardText.className = "region-card-text";
  const cardNote = doc.createElement("p");
  cardNote.className = "region-card-note";
  const cardSource = doc.createElement("p");
  cardSource.className = "region-card-source";
  const sourceLink = doc.createElement("a");
  sourceLink.href = opts.source.url;
  sourceLink.rel = "noopener noreferrer";
  sourceLink.target = "_blank";
  sourceLink.textContent = `Fuente: ${opts.source.title.replace(/\s*—.*$/, "")} (${opts.source.publisher})`;
  cardSource.appendChild(sourceLink);

  const showRegion = (region: Region): void => {
    cardTitle.textContent = region.name;
    cardDepartments.textContent =
      `Departamentos: ${region.departments.join(", ")}.`;
    cardText.textContent = region.description.text;
    // The source's caveat, quoted verbatim so nothing is reworded.
    cardNote.hidden = region.nuance === undefined;
    cardNote.textContent =
      region.nuance === undefined
        ? ""
        : `Nota: la fuente aclara: «${region.nuance}».`;
    card.hidden = false;
  };

  for (const region of opts.regions) {
    const item = doc.createElement("li");
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "region-item";
    const swatch = doc.createElement("span");
    swatch.className = "region-swatch";
    swatch.style.background = REGION_COLORS[region.id].css;
    const name = doc.createElement("span");
    name.className = "region-name";
    name.textContent = region.name;
    button.append(swatch, name);
    button.addEventListener("click", () => {
      showRegion(region);
    });
    item.appendChild(button);
    legendItems.appendChild(item);
  }

  checkbox.addEventListener("change", () => {
    if (!checkbox.checked) card.hidden = true;
    else legendDismissed = false;
    renderLegend();
    opts.onToggle(checkbox.checked);
  });

  card.append(
    cardClose,
    cardTitle,
    cardDepartments,
    cardText,
    cardNote,
    cardSource,
  );
  renderLegend();
  panel.append(toggleLabel, legend, legendReopen, card);
  return panel;
}
