/**
 * Schema and pure build helpers for data/build/places.json, produced by
 * scripts/build-places.ts from data/raw/places/wikidata-places.json plus
 * the project's DEMs and department raster.
 *
 * Per the task doc (odd/tasks/maqueta-lugares.md) the card shows: name,
 * Spanish description (or null), coordinates, DEM elevation —
 * the full-resolution sample always and the detail-patch sample when the
 * point falls inside a patch — the department from the boundary raster,
 * and links to Wikidata / es.wikipedia. Region is deliberately absent
 * (its source has no open license) and no Wikipedia text is copied
 * (CC BY-SA); the article is only linked.
 *
 * Pure data access — nothing here touches the GPU or the DOM (same
 * contract as detail-manifest.ts).
 */
import {
  TerrainHttpError,
  type FetchLike,
} from "./heightfield";
import { OUTSIDE_JUJUY } from "../ui/pick-panel";

const defaultFetch: FetchLike = (url) => fetch(url);

/** places.json schema version produced by the pipeline. */
export const PLACES_SCHEMA_VERSION = 2;

/** Thrown when a places document fails validation. */
export class PlacesDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlacesDataError";
  }
}

// ---------------------------------------------------------------------------
// Raw input: data/raw/places/wikidata-places.json (downloaded once by the
// coordinator; lastrevid is the provenance, verified by verify-places).
// ---------------------------------------------------------------------------

export interface RawWikidataPlace {
  readonly id: string;
  readonly lastrevid: number;
  readonly url: string;
  readonly label: {
    readonly es: string | null;
    readonly en: string | null;
  };
  readonly description: {
    readonly es: string | null;
    readonly en: string | null;
  };
  readonly coordinates: {
    readonly lat: number;
    readonly lon: number;
    readonly precision?: number | null;
  };
  /** es.wikipedia article title, or null when the item has none. */
  readonly eswiki: string | null;
}

export interface RawWikidataPlacesDoc {
  readonly description?: string;
  readonly license?: string;
  readonly places: readonly RawWikidataPlace[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

/**
 * Every key a raw place entry may carry — all verbatim Wikidata values
 * (labels, descriptions, P625, sitelinks, lastrevid). Anything else is a
 * non-Wikidata field that must not ride along in the CC0 extract.
 */
const RAW_PLACE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "lastrevid",
  "url",
  "label",
  "description",
  "coordinates",
  "eswiki",
]);
const RAW_LANG_KEYS: ReadonlySet<string> = new Set(["es", "en"]);
const RAW_COORD_KEYS: ReadonlySet<string> = new Set([
  "lat",
  "lon",
  "precision",
]);

function unknownKeys(
  record: object,
  allowed: ReadonlySet<string>,
): string[] {
  return Object.keys(record).filter((key) => !allowed.has(key));
}

export function assertRawPlacesDoc(
  value: unknown,
): asserts value is RawWikidataPlacesDoc {
  const doc = value as RawWikidataPlacesDoc | null;
  if (!isRecord(doc) || !Array.isArray(doc.places)) {
    throw new PlacesDataError(
      "wikidata-places.json is missing or has no places array",
    );
  }
  for (const [k, place] of doc.places.entries()) {
    const what = `wikidata-places.json places[${k}]`;
    if (
      !isRecord(place) ||
      typeof place.id !== "string" ||
      !/^Q[1-9]\d*$/.test(place.id) ||
      typeof place.lastrevid !== "number" ||
      typeof place.url !== "string" ||
      !isRecord(place.label) ||
      !isNullableString(place.label.es) ||
      !isNullableString(place.label.en) ||
      !isRecord(place.description) ||
      !isNullableString(place.description.es) ||
      !isNullableString(place.description.en) ||
      !isRecord(place.coordinates) ||
      typeof place.coordinates.lat !== "number" ||
      typeof place.coordinates.lon !== "number" ||
      !isNullableString(place.eswiki)
    ) {
      throw new PlacesDataError(
        `${what} (id ${isRecord(place) ? String(place.id) : "?"}) is not a ` +
          "valid Wikidata place entry",
      );
    }
    const extra = [
      ...unknownKeys(place, RAW_PLACE_KEYS),
      ...unknownKeys(place.label, RAW_LANG_KEYS).map((key) => `label.${key}`),
      ...unknownKeys(place.description, RAW_LANG_KEYS).map(
        (key) => `description.${key}`,
      ),
      ...unknownKeys(place.coordinates, RAW_COORD_KEYS).map(
        (key) => `coordinates.${key}`,
      ),
    ];
    if (extra.length > 0) {
      throw new PlacesDataError(
        `${what} (id ${place.id}) carries non-Wikidata field(s): ` +
          extra.join(", "),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Build output: data/build/places.json.
// ---------------------------------------------------------------------------

/** Where the card's elevation figure comes from. */
export type PlaceElevationSource = "dem" | "detail-dem";

export interface Place {
  /** Wikidata item id ("Q…"). */
  readonly id: string;
  /** label.es, falling back to label.en. */
  readonly name: string;
  /** description.es, or null — the card shows "Sin descripción". */
  readonly description: string | null;
  readonly lat: number;
  readonly lon: number;
  /**
   * The elevation the card reports: the detail-patch sample when one
   * exists, else the full-resolution DEM sample. Rounded to the meter.
   */
  readonly elevationMeters: number;
  readonly elevationSource: PlaceElevationSource;
  /** Full-resolution DEM elevation, rounded to the meter. */
  readonly demElevationMeters: number;
  /**
   * Detail-patch DEM elevation, rounded to the meter; present only when
   * the point falls inside a detail patch.
   */
  readonly detailElevationMeters?: number;
  /**
   * Department name verbatim from the geoBoundaries raster, or
   * "Fuera de Jujuy" when the point falls outside the province.
   */
  readonly department: string;
  readonly wikidataUrl: string;
  /** es.wikipedia article URL built from the sitelink title, or null. */
  readonly eswikiUrl: string | null;
}

/** Data provenance block written into places.json. */
export interface PlacesSources {
  readonly places: {
    readonly provider: string;
    readonly license: string;
    readonly licenseUrl: string;
    readonly file: string;
    readonly sha256: string;
  };
  readonly elevation: {
    readonly provider: string;
    readonly file: string;
    readonly detailFiles: string;
    readonly note: string;
  };
  readonly boundaries: {
    readonly provider: string;
    readonly license: string;
    readonly file: string;
  };
}

export interface PlacesDoc {
  readonly schemaVersion: number;
  /** Version of the places pipeline; part of the build cache key. */
  readonly pipelineVersion: number;
  /** sha256 of every input the output was computed from. */
  readonly inputSha256: string;
  readonly sources: PlacesSources;
  readonly places: readonly Place[];
}

function assertPlace(value: unknown, what: string): asserts value is Place {
  const p = value as Place | null;
  if (
    !isRecord(p) ||
    typeof p.id !== "string" ||
    typeof p.name !== "string" ||
    !isNullableString(p.description) ||
    typeof p.lat !== "number" ||
    typeof p.lon !== "number" ||
    typeof p.elevationMeters !== "number" ||
    (p.elevationSource !== "dem" && p.elevationSource !== "detail-dem") ||
    typeof p.demElevationMeters !== "number" ||
    (p.detailElevationMeters !== undefined &&
      typeof p.detailElevationMeters !== "number") ||
    typeof p.department !== "string" ||
    typeof p.wikidataUrl !== "string" ||
    !isNullableString(p.eswikiUrl)
  ) {
    throw new PlacesDataError(`${what} is not a valid place entry`);
  }
}

export function assertPlacesDoc(value: unknown): asserts value is PlacesDoc {
  const doc = value as PlacesDoc | null;
  if (
    !isRecord(doc) ||
    doc.schemaVersion !== PLACES_SCHEMA_VERSION ||
    typeof doc.pipelineVersion !== "number" ||
    typeof doc.inputSha256 !== "string" ||
    !isRecord(doc.sources) ||
    !Array.isArray(doc.places)
  ) {
    throw new PlacesDataError(
      "places.json is missing or does not match schema version " +
        PLACES_SCHEMA_VERSION,
    );
  }
  for (const [k, place] of doc.places.entries()) {
    assertPlace(place, `places.json places[${k}]`);
  }
}

/**
 * Fetch and validate places.json. Throws TerrainHttpError on HTTP errors
 * and PlacesDataError on schema mismatches.
 */
export async function loadPlaces(
  fetchFn: FetchLike,
  url = "places.json",
): Promise<PlacesDoc> {
  const res = await fetchFn(url);
  if (!res.ok) throw new TerrainHttpError(url, res.status);
  const body: unknown = await res.json();
  assertPlacesDoc(body);
  return body;
}

// ---------------------------------------------------------------------------
// Pure build helpers (also unit-tested).
// ---------------------------------------------------------------------------

/**
 * es.wikipedia article URL for a sitelink title. MediaWiki canonicalizes
 * spaces to underscores; the rest is percent-encoded so accented titles
 * (Serranía, Chañi) produce a valid URL.
 */
export function eswikiArticleUrl(title: string): string {
  return (
    "https://es.wikipedia.org/wiki/" +
    encodeURIComponent(title.replace(/ /g, "_"))
  );
}

/** Display name: label.es, falling back to label.en. */
export function placeDisplayName(place: RawWikidataPlace): string {
  const name = place.label.es ?? place.label.en;
  if (name === null) {
    throw new PlacesDataError(`${place.id} has neither label.es nor label.en`);
  }
  return name;
}

/**
 * Card description: description.es only — no English fallback, because a
 * Spanish UI should not silently show English text; null renders as
 * "Sin descripción".
 */
export function placeDescription(place: RawWikidataPlace): string | null {
  if (place.id in WITHHELD_DESCRIPTIONS) return null;
  return place.description.es;
}

/**
 * Wikidata descriptions withheld from the card because a primary source
 * contradicts them. Suppression only: no replacement text is written here.
 * Keyed by Q-id; the value records the contradicting source.
 */
export const WITHHELD_DESCRIPTIONS: Readonly<Record<string, string>> = {
  // Wikidata says "el salar más grande de la Argentina"; the official tourism
  // site lists Salinas Grandes as third in the world after Uyuni and Arizaro
  // (Salta), so Arizaro is larger within Argentina.
  Q2893104:
    "https://www.argentina.travel/novedades/siete-razones-por-las-que-las-salinas-grandes-son-unas-de-las-siete-maravillas-naturales-de-argentina",
};

/** Inputs buildPlaceEntry cannot derive from the raw place alone. */
export interface PlaceSurvey {
  /** Bilinear sample of the full-resolution DEM, in meters. */
  readonly demElevationMeters: number;
  /**
   * Bilinear sample of a detail-patch DEM, in meters — set when the point
   * falls inside a patch's grid.
   */
  readonly detailElevationMeters?: number;
  /**
   * Department name from the boundary raster; undefined means the point
   * falls outside the province (reported as "Fuera de Jujuy").
   */
  readonly department?: string;
}

/**
 * One output place entry: the raw fields plus the surveyed elevation and
 * department. Elevations are rounded to the meter here so every consumer
 * sees the same figure.
 */
export function buildPlaceEntry(
  place: RawWikidataPlace,
  survey: PlaceSurvey,
): Place {
  const demElevationMeters = Math.round(survey.demElevationMeters);
  const detailElevationMeters =
    survey.detailElevationMeters === undefined
      ? undefined
      : Math.round(survey.detailElevationMeters);
  const fromDetail = detailElevationMeters !== undefined;
  return {
    id: place.id,
    name: placeDisplayName(place),
    description: placeDescription(place),
    lat: place.coordinates.lat,
    lon: place.coordinates.lon,
    elevationMeters: fromDetail
      ? detailElevationMeters
      : demElevationMeters,
    elevationSource: fromDetail ? "detail-dem" : "dem",
    demElevationMeters,
    ...(fromDetail ? { detailElevationMeters } : {}),
    department: survey.department ?? OUTSIDE_JUJUY,
    wikidataUrl: place.url,
    eswikiUrl:
      place.eswiki === null ? null : eswikiArticleUrl(place.eswiki),
  };
}
