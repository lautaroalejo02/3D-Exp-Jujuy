/**
 * Schema and pure build helpers for data/build/places.json, produced by
 * scripts/build-places.ts from data/raw/places/wikidata-places.json plus
 * the project's DEMs and department raster.
 *
 * Per the task doc (odd/tasks/maqueta-lugares.md) the card shows: name,
 * Spanish description (or null), coordinates, DEM elevation —
 * the full-resolution sample always and the detail-patch sample when the
 * point falls inside a patch — the department from the boundary raster,
 * and links to Wikidata / es.wikipedia. Region is not stored here; the
 * card resolves it at render time from the PIP Jujuy grouping
 * (src/features/places/place-region.ts).
 *
 * Schema v3 (odd/tasks/maqueta-lugares-fichas.md) merges the three
 * sibling raw files into each place: Commons photos (each with author,
 * license and links — CC BY / CC BY-SA / CC0 / public domain, approved
 * by Lautaro 2026-10-03), the es.wikipedia lead extract (CC BY-SA 4.0,
 * shown verbatim with attribution) and structured Wikidata facts (CC0).
 * Schema v4 adds each photo's Commons credit line as the author
 * fallback and restricts photo licenses to PHOTO_LICENSE_RE both in
 * the raw download and in the built document.
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
export const PLACES_SCHEMA_VERSION = 4;

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
// Raw input: data/raw/places/commons-photos.json (downloaded once by the
// coordinator; licenses are re-checked by verify-places). Every photo is
// served at runtime from upload.wikimedia.org — nothing is committed.
// ---------------------------------------------------------------------------

export interface RawCommonsPhoto {
  readonly file: string;
  readonly pageUrl: string;
  readonly thumbUrl: string;
  readonly thumbWidth: number;
  readonly thumbHeight: number;
  /** Original file dimensions, px. */
  readonly width: number;
  readonly height: number;
  readonly license: string;
  /** Null for public-domain files, which carry no license deed. */
  readonly licenseUrl: string | null;
  /** Null when Commons reports no author. */
  readonly author: string | null;
  readonly credit: string | null;
  readonly description: string | null;
  readonly isMain: boolean;
}

export interface RawCommonsPhotosPlace {
  readonly id: string;
  /** P373 category, or null when the item has none (then photos is []). */
  readonly commonsCategory: string | null;
  readonly photos: readonly RawCommonsPhoto[];
}

export interface RawCommonsPhotosDoc {
  readonly description?: string;
  readonly downloaded?: string;
  readonly by?: string;
  readonly places: readonly RawCommonsPhotosPlace[];
}

const RAW_PHOTOS_PLACE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "commonsCategory",
  "photos",
]);
const RAW_PHOTO_KEYS: ReadonlySet<string> = new Set([
  "file",
  "pageUrl",
  "thumbUrl",
  "thumbWidth",
  "thumbHeight",
  "width",
  "height",
  "license",
  "licenseUrl",
  "author",
  "credit",
  "description",
  "isMain",
]);

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && value > 0;
}

/**
 * Licenses the card is allowed to show (AGENTS.md — CC BY, CC BY-SA,
 * CC0 and public domain, approved by Lautaro 2026-10-03). The version
 * digit is optional in the second decimal ("CC BY 4" and "CC BY 4.0"
 * are both valid). Anything else fails the build.
 */
export const PHOTO_LICENSE_RE =
  /^(CC BY(-SA)? \d(\.\d)?|CC0|Public domain)$/;

/**
 * Subset of PHOTO_LICENSE_RE that legally requires naming the author:
 * CC BY and CC BY-SA (any version). CC0 and public domain carry no
 * attribution requirement.
 */
const ATTRIBUTION_LICENSE_RE = /^CC BY(-SA)? \d(\.\d)?$/;

export function assertRawCommonsPhotosDoc(
  value: unknown,
): asserts value is RawCommonsPhotosDoc {
  const doc = value as RawCommonsPhotosDoc | null;
  if (!isRecord(doc) || !Array.isArray(doc.places)) {
    throw new PlacesDataError(
      "commons-photos.json is missing or has no places array",
    );
  }
  for (const [k, place] of doc.places.entries()) {
    const what = `commons-photos.json places[${k}]`;
    if (
      !isRecord(place) ||
      typeof place.id !== "string" ||
      !/^Q[1-9]\d*$/.test(place.id) ||
      !isNullableString(place.commonsCategory) ||
      !Array.isArray(place.photos)
    ) {
      throw new PlacesDataError(
        `${what} is not a valid Commons photos place entry`,
      );
    }
    const extraPlace = unknownKeys(place, RAW_PHOTOS_PLACE_KEYS);
    if (extraPlace.length > 0) {
      throw new PlacesDataError(
        `${what} (id ${place.id}) carries non-Wikimedia field(s): ` +
          extraPlace.join(", "),
      );
    }
    for (const [p, photo] of place.photos.entries()) {
      const photoWhat = `${what}.photos[${p}]`;
      if (
        !isRecord(photo) ||
        typeof photo.file !== "string" ||
        typeof photo.pageUrl !== "string" ||
        typeof photo.thumbUrl !== "string" ||
        typeof photo.thumbWidth !== "number" ||
        typeof photo.thumbHeight !== "number" ||
        !isPositiveNumber(photo.width) ||
        !isPositiveNumber(photo.height) ||
        typeof photo.license !== "string" ||
        !isNullableString(photo.licenseUrl) ||
        !isNullableString(photo.author) ||
        !isNullableString(photo.credit) ||
        !isNullableString(photo.description) ||
        typeof photo.isMain !== "boolean"
      ) {
        throw new PlacesDataError(
          `${photoWhat} is not a valid Commons photo entry`,
        );
      }
      const extra = unknownKeys(photo, RAW_PHOTO_KEYS);
      if (extra.length > 0) {
        throw new PlacesDataError(
          `${photoWhat} carries non-Wikimedia field(s): ${extra.join(", ")}`,
        );
      }
      if (!PHOTO_LICENSE_RE.test(photo.license)) {
        throw new PlacesDataError(
          `${photoWhat} (${photo.file}) has a license the card cannot ` +
            `show: "${photo.license}"`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Raw input: data/raw/places/wikipedia-extracts.json (es.wikipedia REST v1
// summaries; revision ids re-checked by verify-places). CC BY-SA 4.0.
// ---------------------------------------------------------------------------

export interface RawWikipediaExtract {
  readonly id: string;
  readonly title: string;
  /** Page revision id the extract was taken from, as a decimal string. */
  readonly revision: string;
  readonly url: string;
  readonly extract: string;
  readonly license: string;
  readonly licenseUrl: string;
}

export interface RawWikipediaExtractsDoc {
  readonly description?: string;
  readonly downloaded?: string;
  readonly by?: string;
  readonly places: readonly RawWikipediaExtract[];
}

const RAW_EXTRACT_KEYS: ReadonlySet<string> = new Set([
  "id",
  "title",
  "revision",
  "url",
  "extract",
  "license",
  "licenseUrl",
]);

export function assertRawWikipediaExtractsDoc(
  value: unknown,
): asserts value is RawWikipediaExtractsDoc {
  const doc = value as RawWikipediaExtractsDoc | null;
  if (!isRecord(doc) || !Array.isArray(doc.places)) {
    throw new PlacesDataError(
      "wikipedia-extracts.json is missing or has no places array",
    );
  }
  for (const [k, extract] of doc.places.entries()) {
    const what = `wikipedia-extracts.json places[${k}]`;
    if (
      !isRecord(extract) ||
      typeof extract.id !== "string" ||
      !/^Q[1-9]\d*$/.test(extract.id) ||
      typeof extract.title !== "string" ||
      typeof extract.revision !== "string" ||
      !/^\d+$/.test(extract.revision) ||
      typeof extract.url !== "string" ||
      typeof extract.extract !== "string" ||
      typeof extract.license !== "string" ||
      typeof extract.licenseUrl !== "string"
    ) {
      throw new PlacesDataError(
        `${what} (id ${isRecord(extract) ? String(extract.id) : "?"}) is ` +
          "not a valid Wikipedia extract entry",
      );
    }
    const extra = unknownKeys(extract, RAW_EXTRACT_KEYS);
    if (extra.length > 0) {
      throw new PlacesDataError(
        `${what} (id ${extract.id}) carries non-Wikipedia field(s): ` +
          extra.join(", "),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Raw input: data/raw/places/wikidata-facts.json (structured claims:
// instance-of, latest population with date, area, heritage, inception).
// CC0 like the base extract.
// ---------------------------------------------------------------------------

/** Wikidata time literal, e.g. "+2022-00-00T00:00:00Z". */
const WIKIDATA_TIME_RE = /^[+-]\d+-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export interface RawWikidataFacts {
  readonly id: string;
  readonly lastrevid: number;
  readonly instanceOf: readonly string[];
  readonly population: {
    readonly amount: number;
    readonly date: string;
  } | null;
  readonly areaKm2: number | null;
  readonly heritage: readonly string[];
  readonly inception: string | null;
}

export interface RawWikidataFactsDoc {
  readonly description?: string;
  readonly downloaded?: string;
  readonly by?: string;
  readonly places: readonly RawWikidataFacts[];
}

const RAW_FACTS_KEYS: ReadonlySet<string> = new Set([
  "id",
  "lastrevid",
  "instanceOf",
  "population",
  "areaKm2",
  "heritage",
  "inception",
]);

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((v) => typeof v === "string")
  );
}

export function assertRawWikidataFactsDoc(
  value: unknown,
): asserts value is RawWikidataFactsDoc {
  const doc = value as RawWikidataFactsDoc | null;
  if (!isRecord(doc) || !Array.isArray(doc.places)) {
    throw new PlacesDataError(
      "wikidata-facts.json is missing or has no places array",
    );
  }
  for (const [k, facts] of doc.places.entries()) {
    const what = `wikidata-facts.json places[${k}]`;
    if (
      !isRecord(facts) ||
      typeof facts.id !== "string" ||
      !/^Q[1-9]\d*$/.test(facts.id) ||
      typeof facts.lastrevid !== "number" ||
      !isStringArray(facts.instanceOf) ||
      !(
        facts.population === null ||
        (isRecord(facts.population) &&
          typeof facts.population.amount === "number" &&
          typeof facts.population.date === "string" &&
          WIKIDATA_TIME_RE.test(facts.population.date))
      ) ||
      !(facts.areaKm2 === null || typeof facts.areaKm2 === "number") ||
      !isStringArray(facts.heritage) ||
      !(
        facts.inception === null ||
        (typeof facts.inception === "string" &&
          WIKIDATA_TIME_RE.test(facts.inception))
      )
    ) {
      throw new PlacesDataError(
        `${what} (id ${isRecord(facts) ? String(facts.id) : "?"}) is ` +
          "not a valid Wikidata facts entry",
      );
    }
    const extra = unknownKeys(facts, RAW_FACTS_KEYS);
    if (extra.length > 0) {
      throw new PlacesDataError(
        `${what} (id ${facts.id}) carries non-Wikidata field(s): ` +
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

/**
 * One Commons photo for the card's strip and lightbox. `thumbUrl` is the
 * strip image (with utm_* params stripped); `fullUrl` is a larger
 * thumbnail for the lightbox — up to 1600 px, capped at the original
 * width, or the original file URL when the download stored one.
 * `width`/`height` are the ORIGINAL file's dimensions — their ratio is
 * what the <img> width/height attributes reserve.
 */
export interface PlacePhoto {
  readonly thumbUrl: string;
  readonly fullUrl: string;
  readonly width: number;
  readonly height: number;
  readonly author: string | null;
  /** Credit line from Commons, shown when the file reports no author. */
  readonly credit: string | null;
  readonly license: string;
  readonly licenseUrl: string | null;
  /** Commons file page — the credit line's "see this photo" link. */
  readonly pageUrl: string;
  readonly description: string | null;
}

/** es.wikipedia lead extract shown verbatim under "Ver más". */
export interface PlaceExtract {
  readonly text: string;
  /** Article URL. */
  readonly url: string;
  /** Revision the extract was taken from (provenance + verify target). */
  readonly revision: string;
  readonly license: string;
  readonly licenseUrl: string;
}

/** Structured Wikidata facts; every field may be absent in the source. */
export interface PlaceFacts {
  readonly instanceOf: readonly string[];
  readonly population: {
    readonly amount: number;
    readonly year: number;
  } | null;
  readonly areaKm2: number | null;
  readonly heritage: readonly string[];
  readonly foundedYear: number | null;
}

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
  /** Commons photos, main image first. Empty when the place has none. */
  readonly photos: readonly PlacePhoto[];
  /** es.wikipedia lead extract, or null. */
  readonly extract: PlaceExtract | null;
  /** Structured Wikidata facts, or null. */
  readonly facts: PlaceFacts | null;
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
  readonly photos: {
    readonly provider: string;
    readonly license: string;
    readonly file: string;
    readonly sha256: string;
    readonly note: string;
  };
  readonly extracts: {
    readonly provider: string;
    readonly license: string;
    readonly licenseUrl: string;
    readonly file: string;
    readonly sha256: string;
  };
  readonly facts: {
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

function isPlacePhoto(value: unknown): value is PlacePhoto {
  const photo = value as PlacePhoto | null;
  return (
    isRecord(photo) &&
    typeof photo.thumbUrl === "string" &&
    typeof photo.fullUrl === "string" &&
    typeof photo.width === "number" &&
    typeof photo.height === "number" &&
    isNullableString(photo.author) &&
    isNullableString(photo.credit) &&
    typeof photo.license === "string" &&
    PHOTO_LICENSE_RE.test(photo.license) &&
    isNullableString(photo.licenseUrl) &&
    typeof photo.pageUrl === "string" &&
    isNullableString(photo.description)
  );
}

function isPlaceExtract(value: unknown): value is PlaceExtract {
  const extract = value as PlaceExtract | null;
  return (
    isRecord(extract) &&
    typeof extract.text === "string" &&
    typeof extract.url === "string" &&
    typeof extract.revision === "string" &&
    typeof extract.license === "string" &&
    typeof extract.licenseUrl === "string"
  );
}

function isPlaceFacts(value: unknown): value is PlaceFacts {
  const facts = value as PlaceFacts | null;
  return (
    isRecord(facts) &&
    isStringArray(facts.instanceOf) &&
    (facts.population === null ||
      (isRecord(facts.population) &&
        typeof facts.population.amount === "number" &&
        typeof facts.population.year === "number")) &&
    (facts.areaKm2 === null || typeof facts.areaKm2 === "number") &&
    isStringArray(facts.heritage) &&
    (facts.foundedYear === null || typeof facts.foundedYear === "number")
  );
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
    !isNullableString(p.eswikiUrl) ||
    !Array.isArray(p.photos) ||
    !p.photos.every(isPlacePhoto) ||
    !(p.extract === null || isPlaceExtract(p.extract)) ||
    !(p.facts === null || isPlaceFacts(p.facts))
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

/** Card content merged from the sibling raw files (schema v3). */
export interface PlaceExtras {
  readonly photos?: readonly PlacePhoto[];
  readonly extract?: PlaceExtract | null;
  readonly facts?: PlaceFacts | null;
}

/**
 * One output place entry: the raw fields plus the surveyed elevation and
 * department. Elevations are rounded to the meter here so every consumer
 * sees the same figure.
 */
export function buildPlaceEntry(
  place: RawWikidataPlace,
  survey: PlaceSurvey,
  extras: PlaceExtras = {},
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
    photos: extras.photos ?? [],
    extract: extras.extract ?? null,
    facts: extras.facts ?? null,
  };
}

// ---------------------------------------------------------------------------
// Merge helpers: raw Commons / Wikipedia / facts records -> card fields.
// ---------------------------------------------------------------------------

/** Lightbox image width derived from Commons thumb URLs, px. */
const FULL_IMAGE_WIDTH_PX = 1600;

/**
 * Remove utm_* tracking params from a URL, keeping every other param.
 * The download appended them for provenance (?utm_source=commons…);
 * they are noise for the runtime image fetches.
 */
export function stripTrackingParams(url: string): string {
  const q = url.indexOf("?");
  if (q === -1) return url;
  const kept = url
    .slice(q + 1)
    .split("&")
    .filter((param) => !param.split("=", 1)[0]?.startsWith("utm_"));
  return url.slice(0, q) + (kept.length > 0 ? `?${kept.join("&")}` : "");
}

/**
 * Larger-image URL for the lightbox, derived from the Commons thumbnail
 * pattern (…/thumb/<hash>/<file>/<N>px-<file>): swap the size for
 * min(1600 px, original width) — thumbor never upscales raster files.
 * URLs that are not thumbnails (original files under
 * upload.wikimedia.org) return unchanged: they already ARE the full
 * image, stored that way when the original is small.
 */
export function commonsFullImageUrl(
  thumbUrl: string,
  originalWidth: number,
): string {
  if (!thumbUrl.includes("/thumb/")) return thumbUrl;
  const target = Math.min(
    FULL_IMAGE_WIDTH_PX,
    Math.max(1, Math.floor(originalWidth)),
  );
  return thumbUrl.replace(/\d+px-([^/]+)$/, `${target}px-$1`);
}

/**
 * Year of a Wikidata time literal ("+2022-00-00T00:00:00Z" -> 2022,
 * including negative years). Null when the string is not a time literal —
 * never a guessed year.
 */
export function wikidataTimeYear(time: string): number | null {
  const match = /^([+-])(\d+)-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.exec(time);
  if (!match) return null;
  const year = Number.parseInt(match[2] ?? "", 10);
  return match[1] === "-" ? -year : year;
}

/**
 * True when a raw photo cannot satisfy its license on the card: CC BY
 * and CC BY-SA (any version) require naming the author, so a file that
 * reports neither an author nor a credit line must not ship. Public
 * domain and CC0 carry no attribution requirement — they may ship
 * authorless. build-places drops these and prints their file names.
 */
export function unattributablePhoto(photo: RawCommonsPhoto): boolean {
  return (
    ATTRIBUTION_LICENSE_RE.test(photo.license) &&
    photo.author === null &&
    photo.credit === null
  );
}

/** Raw Commons photo -> card photo with cleaned/derived URLs. */
export function buildPlacePhoto(photo: RawCommonsPhoto): PlacePhoto {
  const thumbUrl = stripTrackingParams(photo.thumbUrl);
  return {
    thumbUrl,
    fullUrl: commonsFullImageUrl(thumbUrl, photo.width),
    width: photo.width,
    height: photo.height,
    author: photo.author,
    credit: photo.credit,
    license: photo.license,
    licenseUrl: photo.licenseUrl,
    pageUrl: photo.pageUrl,
    description: photo.description,
  };
}

/** Raw es.wikipedia extract -> card extract. */
export function buildPlaceExtract(
  extract: RawWikipediaExtract,
): PlaceExtract {
  return {
    text: extract.extract,
    url: extract.url,
    revision: extract.revision,
    license: extract.license,
    licenseUrl: extract.licenseUrl,
  };
}

/**
 * Year of a Wikidata time literal that MUST parse (population date,
 * inception). The raw validator already guarantees the format; anything
 * else is a bug worth failing the build over — never a guessed year.
 */
function requiredYear(time: string, what: string): number {
  const year = wikidataTimeYear(time);
  if (year === null) {
    throw new PlacesDataError(`${what}: unparseable time "${time}"`);
  }
  return year;
}

/** Raw Wikidata facts -> card facts; time literals become years. */
export function buildPlaceFacts(facts: RawWikidataFacts): PlaceFacts {
  return {
    instanceOf: facts.instanceOf,
    population:
      facts.population === null
        ? null
        : {
            amount: facts.population.amount,
            year: requiredYear(facts.population.date, `${facts.id} population`),
          },
    areaKm2: facts.areaKm2,
    heritage: facts.heritage,
    foundedYear:
      facts.inception === null
        ? null
        : requiredYear(facts.inception, `${facts.id} inception`),
  };
}
