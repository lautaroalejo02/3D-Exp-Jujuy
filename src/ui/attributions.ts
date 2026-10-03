/**
 * Data attribution panel. The texts come verbatim from ATTRIBUTIONS.md; add
 * new sources there first, then extend ATTRIBUTIONS below.
 */
import type { DropdownGroup } from "./dropdowns";

export interface AttributionLink {
  readonly label: string;
  readonly url: string;
}

export interface AttributionSource {
  readonly title: string;
  readonly lines: readonly string[];
  readonly links: readonly AttributionLink[];
}

export const ATTRIBUTIONS: readonly AttributionSource[] = [
  {
    title: "Relieve (DEM)",
    lines: [
      "Mapzen",
      "SRTM data courtesy of the U.S. Geological Survey",
      "GMTED2010 data courtesy of the U.S. Geological Survey",
      "ETOPO1: DOC/NOAA/NESDIS/NCEI > National Centers for Environmental Information, NESDIS, NOAA, U.S. Department of Commerce",
    ],
    links: [
      {
        label: "Fuente",
        url: "https://github.com/tilezen/joerd/blob/master/docs/attribution.md",
      },
    ],
  },
  {
    title: "Imagen satelital",
    lines: [
      "Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016)",
    ],
    links: [
      {
        label: "CC BY 4.0",
        url: "https://creativecommons.org/licenses/by/4.0/",
      },
    ],
  },
  {
    title: "Lugares (nombres, descripciones)",
    lines: ["Wikidata"],
    links: [
      {
        label: "CC0 1.0",
        url: "https://creativecommons.org/publicdomain/zero/1.0/",
      },
      {
        label: "Fuente",
        url: "https://www.wikidata.org/",
      },
    ],
  },
  {
    title: "Lugares (coordenadas corregidas)",
    lines: [
      "OpenStreetMap — © OpenStreetMap contributors (la ficha enlaza al elemento usado)",
    ],
    links: [
      {
        label: "ODbL 1.0",
        url: "https://opendatacommons.org/licenses/odbl/1-0/",
      },
      {
        label: "Fuente",
        url: "https://www.openstreetmap.org/copyright",
      },
    ],
  },
  {
    title: "Lugares (datos: tipo, población, superficie, patrimonio, fundación)",
    lines: ["Wikidata"],
    links: [
      {
        label: "CC0 1.0",
        url: "https://creativecommons.org/publicdomain/zero/1.0/",
      },
      {
        label: "Fuente",
        url: "https://www.wikidata.org/",
      },
    ],
  },
  {
    title: "Fotos de los lugares",
    lines: [
      "Wikimedia Commons — cada foto muestra su autor y licencia junto a ella",
      "seleccionadas por relevancia (P18 de Wikidata + «depicts» P180 de Commons)",
    ],
    links: [
      {
        label: "Fuente",
        url: "https://commons.wikimedia.org/",
      },
    ],
  },
  {
    title: "Extractos de los lugares",
    lines: [
      "Wikipedia en español — texto copiado sin cambios junto a cada ficha, con enlace a la revisión",
    ],
    links: [
      {
        label: "CC BY-SA 4.0",
        url: "https://creativecommons.org/licenses/by-sa/4.0/",
      },
      {
        label: "Fuente",
        url: "https://es.wikipedia.org/",
      },
    ],
  },
  {
    title: "Límites departamentales",
    lines: [
      "geoBoundaries — Instituto Geográfico Nacional and UNHCR, OCHA ROLAC",
    ],
    links: [
      {
        label: "CC BY 3.0 IGO",
        url: "https://creativecommons.org/licenses/by/3.0/igo/",
      },
      {
        label: "Fuente",
        url: "https://www.geoboundaries.org/api/current/gbOpen/ARG/ADM2/",
      },
    ],
  },
  {
    title: "Regiones de Jujuy",
    lines: [
      "PIP Jujuy — PISEAR, Ministerio de Agroindustria de la Nación (fuente de texto)",
    ],
    links: [
      {
        label: "Fuente (PDF)",
        url: "https://www.magyp.gob.ar/sitio/areas/pisear/institucional/docs/_archivos/000005_PIP%20Jujuy.pdf",
      },
    ],
  },
];

const COLLAPSED_BELOW_PX = 640;

/**
 * Builds the attribution panel. Always visible — also on the no-WebGPU
 * fallback notice — and collapsed by default on small screens. With a
 * DropdownGroup it joins the one-open-at-a-time / tap-outside-closes
 * coordination the other overlay dropdowns use.
 */
export function createAttributionPanel(
  doc: Document = document,
  dropdowns?: DropdownGroup,
): HTMLElement {
  const details = doc.createElement("details");
  details.className = "attributions";

  const summary = doc.createElement("summary");
  summary.textContent = "Fuentes de datos";
  details.appendChild(summary);

  const list = doc.createElement("ul");
  for (const source of ATTRIBUTIONS) {
    const item = doc.createElement("li");
    const title = doc.createElement("strong");
    title.textContent = `${source.title}: `;
    item.appendChild(title);
    item.appendChild(doc.createTextNode(source.lines.join(" · ")));
    for (const link of source.links) {
      item.appendChild(doc.createTextNode(" ("));
      const anchor = doc.createElement("a");
      anchor.href = link.url;
      anchor.textContent = link.label;
      anchor.rel = "noopener noreferrer";
      anchor.target = "_blank";
      item.appendChild(anchor);
      item.appendChild(doc.createTextNode(")"));
    }
    list.appendChild(item);
  }
  details.appendChild(list);

  const media = doc.defaultView?.matchMedia?.(`(min-width: ${COLLAPSED_BELOW_PX}px)`);
  details.open = media?.matches ?? true;

  if (dropdowns) {
    const entry = {
      container: details,
      close: () => {
        details.open = false;
      },
    };
    details.addEventListener("toggle", () => {
      if (details.open) dropdowns.opened(entry);
      else dropdowns.closed(entry);
    });
  }

  return details;
}
