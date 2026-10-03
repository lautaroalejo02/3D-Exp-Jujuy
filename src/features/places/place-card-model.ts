import type {
  Place,
  PlaceFacts,
  PlacePhoto,
} from "../../terrain/places-manifest";
import {
  formatElevation,
  formatLatitude,
  formatLongitude,
} from "../../ui/pick-panel";

/**
 * Pure content model of the place card ("ficha"): everything the DOM
 * renderer needs, computed without touching the document — so the same
 * decisions are unit-tested in Node. Argentine Spanish, aimed at
 * high-school students; numbers use the "." thousands separator and the
 * "," decimal mark like the pick panel.
 */

export interface PlaceCardRow {
  readonly label: string;
  readonly value: string;
  /** True when the row only shows on the expanded ("Ver más") card. */
  readonly expandedOnly: boolean;
}

export interface PlaceCardLink {
  readonly label: string;
  readonly url: string;
}

export interface PhotoCredit {
  /**
   * The Commons author, or the file's credit line when no author is
   * reported; null only when the file has neither (public domain, CC0).
   */
  readonly author: string | null;
  /** Commons file page — always the author's link target. */
  readonly authorUrl: string;
  readonly license: string;
  /** Null for public-domain photos; the license shows without a link. */
  readonly licenseUrl: string | null;
}

/** "Foto: <autor> · <licencia>" — author and license with their links. */
export function photoCreditLine(photo: PlacePhoto): PhotoCredit {
  return {
    author: photo.author ?? photo.credit,
    authorUrl: photo.pageUrl,
    license: photo.license,
    licenseUrl: photo.licenseUrl,
  };
}

/** "1.838" — thousands grouped with ".", like formatElevation. */
function formatCount(n: number): string {
  const sign = n < 0 ? "-" : "";
  return (
    sign + String(Math.abs(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ".")
  );
}

/** "162,24" — up to 2 decimals, comma decimal mark, no trailing zeros. */
function formatDecimal(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  const [int, frac] = String(Math.abs(rounded)).split(".");
  const grouped = int?.replace(/\B(?=(\d{3})+(?!\d))/g, ".") ?? "0";
  const sign = rounded < 0 ? "-" : "";
  return frac === undefined
    ? `${sign}${grouped}`
    : `${sign}${grouped},${frac}`;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

/**
 * The facts rows under "Ver más" — Tipo, Población, Superficie,
 * Patrimonio, Fundación — skipping every field the source lacks (a row
 * is only emitted when it has data; nothing is invented).
 */
export function placeFactRows(
  facts: PlaceFacts | null,
): readonly { label: string; value: string }[] {
  if (facts === null) return [];
  const rows: { label: string; value: string }[] = [];
  if (facts.instanceOf.length > 0) {
    rows.push({ label: "Tipo", value: capitalize(facts.instanceOf.join(", ")) });
  }
  if (facts.population !== null) {
    rows.push({
      label: "Población",
      value: `${formatCount(facts.population.amount)} (${facts.population.year})`,
    });
  }
  if (facts.areaKm2 !== null) {
    rows.push({ label: "Superficie", value: `${formatDecimal(facts.areaKm2)} km²` });
  }
  if (facts.heritage.length > 0) {
    rows.push({ label: "Patrimonio", value: facts.heritage.join(", ") });
  }
  if (facts.foundedYear !== null) {
    rows.push({ label: "Fundación", value: String(facts.foundedYear) });
  }
  return rows;
}

export interface PlaceCardModel {
  readonly name: string;
  /** description.es, or the "Sin descripción" placeholder text. */
  readonly description: string;
  /** False when the description is the placeholder (rendered dimmed). */
  readonly hasDescription: boolean;
  /** Strip + lightbox source, main image first; empty hides the strip. */
  readonly photos: readonly PlacePhoto[];
  /**
   * Data rows in display order — the expandedOnly flag says which ones
   * the collapsed card hides.
   */
  readonly rows: readonly PlaceCardRow[];
  /** Facts rows, only the fields that have data. */
  readonly factRows: readonly { label: string; value: string }[];
  /** Verbatim Wikipedia extract plus its source line and revision link. */
  readonly extract: {
    readonly text: string;
    readonly url: string;
    /** Link to the exact revision the extract was taken from. */
    readonly revisionUrl: string;
    /** e.g. "CC BY-SA 4.0" — the source line's license text. */
    readonly license: string;
    /** License deed URL, linked next to the source link. */
    readonly licenseUrl: string;
    readonly sourceLine: string;
  } | null;
  /** Elevation-provenance note, shown only on the expanded card. */
  readonly altitudeNote: string;
  readonly links: readonly PlaceCardLink[];
}

/**
 * Content of one place's card. `region` is the already-resolved region
 * label (place-region.ts); when absent the "Región" row is omitted.
 */
export function placeCardModel(place: Place, region?: string): PlaceCardModel {
  const rows: PlaceCardRow[] = [
    { label: "Departamento", value: place.department, expandedOnly: true },
    ...(region !== undefined
      ? [{ label: "Región", value: region, expandedOnly: false }]
      : []),
    {
      label: "Altura",
      value: formatElevation(place.elevationMeters),
      expandedOnly: false,
    },
    {
      label: "Latitud",
      value: formatLatitude(place.lat),
      expandedOnly: true,
    },
    {
      label: "Longitud",
      value: formatLongitude(place.lon),
      expandedOnly: true,
    },
  ];
  return {
    name: place.name,
    description: place.description ?? "Sin descripción",
    hasDescription: place.description !== null,
    photos: place.photos,
    rows,
    factRows: placeFactRows(place.facts),
    extract:
      place.extract === null
        ? null
        : {
            text: place.extract.text,
            url: place.extract.url,
            revisionUrl:
              "https://es.wikipedia.org/w/index.php?oldid=" +
              encodeURIComponent(place.extract.revision),
            license: place.extract.license,
            licenseUrl: place.extract.licenseUrl,
            sourceLine: `Fuente: Wikipedia (${place.extract.license})`,
          },
    altitudeNote:
      place.elevationSource === "detail-dem"
        ? "Altura: modelo de elevación de detalle."
        : "Altura: modelo de elevación.",
    links: [
      { label: "Ver en Wikidata", url: place.wikidataUrl },
      ...(place.eswikiUrl === null
        ? []
        : [{ label: "Artículo en Wikipedia", url: place.eswikiUrl }]),
    ],
  };
}
