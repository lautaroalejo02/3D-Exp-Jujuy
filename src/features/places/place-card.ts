import type {
  Place,
  PlacePhoto,
} from "../../terrain/places-manifest";
import {
  photoCreditLine,
  placeCardModel,
} from "./place-card-model";
import {
  placeRegionLabel,
  regionSourceLabel,
  type PlaceRegionLookup,
} from "./place-region";

/** Source pages for card rows computed from project data (same as ATTRIBUTIONS.md). */
const DEM_SOURCE_URL =
  "https://github.com/tilezen/joerd/blob/master/docs/attribution.md";
const BOUNDARIES_SOURCE_URL =
  "https://www.geoboundaries.org/api/current/gbOpen/ARG/ADM2/";

/**
 * The place card ("ficha") DOM: photo strip on top, name, short
 * description, the always-visible Región/Altura rows and a "Ver más"
 * toggle that reveals the Wikipedia extract, the facts rows, the rest of
 * the data rows and the links. The content comes from placeCardModel —
 * this file only turns it into elements.
 *
 * Rebuilt on every open: the dynamic parts (photos, rows that exist
 * only when their data does) make cached element refs more brittle than
 * a fresh subtree.
 */

export interface PlaceCardOptions {
  readonly regions?: PlaceRegionLookup;
  /** A photo was tapped: open it in the lightbox. */
  readonly onPhoto: (place: Place, index: number) => void;
  /** The card's own close button was pressed. */
  readonly onDismiss: () => void;
}

export interface PlaceCard {
  readonly el: HTMLElement;
  open(place: Place): void;
  close(): void;
}

function externalLink(
  doc: Document,
  url: string,
  label: string,
): HTMLAnchorElement {
  const a = doc.createElement("a");
  a.href = url;
  a.textContent = label;
  a.rel = "noopener noreferrer";
  a.target = "_blank";
  return a;
}

/** "Foto: <autor> · <licencia>" with links to Commons and the license. */
function photoCredit(doc: Document, photo: PlacePhoto): HTMLElement {
  const credit = doc.createElement("figcaption");
  credit.className = "place-card-photo-credit";
  const c = photoCreditLine(photo);
  credit.append(
    doc.createTextNode("Foto: "),
    c.author === null
      ? doc.createTextNode("autor desconocido")
      : externalLink(doc, c.authorUrl, c.author),
    doc.createTextNode(" · "),
  );
  if (c.licenseUrl === null) {
    credit.appendChild(doc.createTextNode(c.license));
  } else {
    credit.appendChild(externalLink(doc, c.licenseUrl, c.license));
  }
  return credit;
}

/** alt text for a photo: its Commons description, else the place name. */
function photoAlt(photo: PlacePhoto, placeName: string): string {
  return photo.description ?? `Foto de ${placeName}`;
}

export function createPlaceCard(
  doc: Document,
  opts: PlaceCardOptions,
): PlaceCard {
  const el = doc.createElement("section");
  el.className = "pick-panel place-card";
  el.hidden = true;
  el.setAttribute("aria-live", "polite");

  let expandedEls: HTMLElement[] = [];
  let moreButton: HTMLButtonElement | undefined;
  let expanded = false;

  const setExpanded = (value: boolean): void => {
    expanded = value;
    for (const node of expandedEls) node.hidden = !value;
    if (moreButton) {
      moreButton.textContent = value ? "Ver menos" : "Ver más";
      moreButton.setAttribute("aria-expanded", String(value));
    }
  };

  const close = (): void => {
    el.hidden = true;
  };

  const render = (place: Place): void => {
    const model = placeCardModel(
      place,
      opts.regions === undefined
        ? undefined
        : placeRegionLabel(place.department, opts.regions),
    );
    el.textContent = "";
    expandedEls = [];

    const closeButton = doc.createElement("button");
    closeButton.type = "button";
    closeButton.className = "pick-panel-close";
    closeButton.textContent = "×";
    closeButton.setAttribute("aria-label", "Cerrar");
    closeButton.addEventListener("click", opts.onDismiss);
    el.appendChild(closeButton);

    // Photo strip — above the description, only when the place has any.
    if (model.photos.length > 0) {
      const strip = doc.createElement("div");
      strip.className = "place-card-photos";
      strip.setAttribute("role", "group");
      strip.setAttribute("aria-label", `Fotos de ${model.name}`);
      model.photos.forEach((photo, index) => {
        const figure = doc.createElement("figure");
        figure.className = "place-card-photo";
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "place-card-photo-button";
        button.setAttribute(
          "aria-label",
          `Ampliar foto ${index + 1} de ${model.photos.length}`,
        );
        const img = doc.createElement("img");
        img.src = photo.thumbUrl;
        img.alt = photoAlt(photo, model.name);
        // Intrinsic ratio reserves the strip space before the fetch.
        img.width = photo.width;
        img.height = photo.height;
        img.loading = "lazy";
        img.decoding = "async";
        button.appendChild(img);
        button.addEventListener("click", () => {
          opts.onPhoto(place, index);
        });
        figure.append(button, photoCredit(doc, photo));
        strip.appendChild(figure);
      });
      el.appendChild(strip);
    }

    const name = doc.createElement("h2");
    name.className = "place-card-name";
    name.textContent = model.name;

    const desc = doc.createElement("p");
    desc.className = "place-card-desc";
    desc.textContent = model.description;
    desc.classList.toggle("place-card-desc--empty", !model.hasDescription);

    moreButton = doc.createElement("button");
    moreButton.type = "button";
    moreButton.className = "place-card-more";
    moreButton.addEventListener("click", () => {
      setExpanded(!expanded);
    });

    const extra = doc.createElement("div");
    extra.className = "place-card-extra";
    if (model.extract !== null) {
      const quote = doc.createElement("blockquote");
      quote.className = "place-card-extract";
      const text = doc.createElement("p");
      text.textContent = model.extract.text;
      quote.appendChild(text);
      const source = doc.createElement("p");
      source.className = "place-card-extract-source";
      source.append(
        doc.createTextNode("Fuente: "),
        externalLink(doc, model.extract.revisionUrl, "Wikipedia"),
        doc.createTextNode(" · "),
        externalLink(doc, model.extract.licenseUrl, model.extract.license),
      );
      extra.append(quote, source);
    }
    if (model.factRows.length > 0) {
      const facts = doc.createElement("dl");
      facts.className = "pick-panel-data place-card-facts";
      for (const row of model.factRows) {
        const dt = doc.createElement("dt");
        dt.textContent = row.label;
        const dd = doc.createElement("dd");
        dd.textContent = row.value;
        facts.append(dt, dd);
      }
      const factsSource = doc.createElement("p");
      factsSource.className = "place-card-facts-source";
      factsSource.append(
        doc.createTextNode("Datos: "),
        externalLink(doc, place.wikidataUrl, "Wikidata"),
        doc.createTextNode(" (CC0)"),
      );
      extra.append(facts, factsSource);
    }
    expandedEls.push(extra);
    extra.id = "place-card-extra";
    moreButton.setAttribute("aria-controls", extra.id);

    const rows = doc.createElement("dl");
    rows.className = "pick-panel-data";
    for (const row of model.rows) {
      const dt = doc.createElement("dt");
      dt.textContent = row.label;
      const dd = doc.createElement("dd");
      dd.textContent = row.value;
      if (row.expandedOnly) expandedEls.push(dt, dd);
      rows.append(dt, dd);
    }

    // Sources of everything shown in the collapsed card stay visible in both
    // states (AGENTS.md: every educational datum carries its source).
    const altNote = doc.createElement("p");
    altNote.className = "pick-panel-note";
    altNote.append(
      doc.createTextNode(`${model.altitudeNote} Fuente: `),
      externalLink(doc, DEM_SOURCE_URL, "Terrain Tiles (Mapzen)"),
      doc.createTextNode("."),
    );

    const sourceNote = doc.createElement("p");
    sourceNote.className = "pick-panel-note";
    if (
      place.coordinateSource === "osm" &&
      typeof place.osmElementUrl === "string"
    ) {
      // The coordinate comes from the OpenStreetMap element (ODbL) —
      // name and description still come from Wikidata.
      sourceNote.append(
        doc.createTextNode("Nombre y descripción: "),
        externalLink(doc, place.wikidataUrl, "Wikidata"),
        doc.createTextNode(" (CC0). Coordenadas: "),
        externalLink(doc, place.osmElementUrl, "OpenStreetMap"),
        doc.createTextNode(" (ODbL)."),
      );
    } else {
      sourceNote.append(
        doc.createTextNode("Nombre, descripción y coordenadas: "),
        externalLink(doc, place.wikidataUrl, "Wikidata"),
        doc.createTextNode(" (CC0)."),
      );
    }
    sourceNote.append(
      doc.createTextNode(" Departamento: "),
      externalLink(doc, BOUNDARIES_SOURCE_URL, "geoBoundaries / IGN"),
      doc.createTextNode(" (CC BY 3.0 IGO)."),
    );
    if (opts.regions) {
      sourceNote.append(
        doc.createTextNode(" Región: "),
        externalLink(
          doc,
          opts.regions.source.url,
          regionSourceLabel(opts.regions.source),
        ),
        doc.createTextNode("."),
      );
    }

    const links = doc.createElement("p");
    links.className = "place-card-links";
    model.links.forEach((link, k) => {
      if (k > 0) links.appendChild(doc.createTextNode(" · "));
      links.appendChild(externalLink(doc, link.url, link.label));
    });
    expandedEls.push(links);

    el.append(name, desc, moreButton, extra, rows, altNote, sourceNote, links);
    setExpanded(false);
  };

  return {
    el,
    open(place: Place): void {
      render(place);
      el.hidden = false;
    },
    close,
  };
}
