/**
 * Re-checks the committed Wikidata extract against live Wikidata: for
 * every place in data/raw/places/wikidata-places.json the entity is
 * fetched once more (Special:EntityData) and its label.es/en,
 * description.es/en, P625 coordinate and eswiki sitelink are compared
 * with the committed record. lastrevid differences are reported as
 * informational notes — entities legitimately change after the download
 * — while content differences and fetch failures are failures.
 *
 * The sibling raw files are re-checked too:
 * - commons-photos.json: every photo's license on its Commons file page
 *   (imageinfo extmetadata, batched titles) is compared with the
 *   committed one — a relicensing or a deleted file is a failure, since
 *   the card can only show what stays in the allowed license set;
 * - wikipedia-extracts.json: every committed revision id is asked back
 *   to es.wikipedia — a revision that no longer resolves is a failure,
 *   since the card's "Fuente" link points at it.
 *
 * Requests run sequentially with a polite User-Agent and a small delay,
 * like verify-detail's one-URL-at-a-time pass. Nothing is ever written —
 * data/raw/ is read-only (AGENTS.md).
 *
 * Run: `npm run verify:places`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertRawCommonsPhotosDoc,
  assertRawPlacesDoc,
  assertRawWikipediaExtractsDoc,
  type RawCommonsPhoto,
  type RawWikidataPlace,
} from "../src/terrain/places-manifest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RAW_DIR = join(ROOT, "data/raw/places");
const RAW_PATH = join(RAW_DIR, "wikidata-places.json");
const RAW_PHOTOS_PATH = join(RAW_DIR, "commons-photos.json");
const RAW_EXTRACTS_PATH = join(RAW_DIR, "wikipedia-extracts.json");

const USER_AGENT =
  "maqueta-jujuy-verify-places/1.0 (educational terrain model for " +
  "Jujuy, Argentina; data check against the project's committed extract)";
const DELAY_MS = 300;
const COORD_EPSILON = 1e-9;

interface WikidataValue {
  readonly value?: unknown;
}

interface WikidataCoordinateClaim {
  readonly rank?: string;
  readonly mainsnak?: {
    readonly datavalue?: {
      readonly value?: {
        readonly latitude?: number;
        readonly longitude?: number;
        readonly precision?: number | null;
      };
    };
  };
}

interface WikidataEntity {
  readonly lastrevid?: number;
  readonly labels?: Record<string, WikidataValue>;
  readonly descriptions?: Record<string, WikidataValue>;
  readonly claims?: Record<string, readonly WikidataCoordinateClaim[]>;
  readonly sitelinks?: Record<string, { readonly title?: string }>;
}

interface WikidataResponse {
  readonly entities?: Record<string, WikidataEntity>;
}

function labelValue(
  entity: WikidataEntity,
  kind: "labels" | "descriptions",
  lang: "es" | "en",
): string | null {
  const v = entity[kind]?.[lang]?.value;
  return typeof v === "string" ? v : null;
}

function coordinateValue(entity: WikidataEntity): {
  lat: number;
  lon: number;
  precision: number | null;
} | null {
  const claims = entity.claims?.P625;
  if (!claims || claims.length === 0) return null;
  // Preferred-rank statement wins; Wikidata keeps one per property here.
  const claim = claims.find((c) => c.rank === "preferred") ?? claims[0];
  const v = claim?.mainsnak?.datavalue?.value;
  if (typeof v?.latitude !== "number" || typeof v.longitude !== "number") {
    return null;
  }
  return {
    lat: v.latitude,
    lon: v.longitude,
    precision: typeof v.precision === "number" ? v.precision : null,
  };
}

function sitelinkTitle(entity: WikidataEntity, site: string): string | null {
  const title = entity.sitelinks?.[site]?.title;
  return typeof title === "string" ? title : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const API_MAX_ATTEMPTS = 4;

/**
 * api.php calls get `maxlag=5` and retried 429/503/maxlag/ratelimited
 * responses — Wikimedia throttles shared egress IPs aggressively and
 * returns API errors as HTTP-200 JSON bodies, which must not be read
 * as "the file is missing".
 */
async function apiGet(url: string, maxlag = false): Promise<unknown> {
  const full = maxlag ? `${url}&maxlag=5` : url;
  let lastError = "unknown";
  for (let attempt = 0; attempt < API_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(5000 * attempt);
    const res = await fetch(full, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (res.status === 429 || res.status === 503) {
      lastError = `HTTP ${res.status}`;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${full}`);
    const body = (await res.json()) as {
      error?: { code?: string; info?: string };
    };
    const apiError = body.error;
    if (apiError !== undefined) {
      if (apiError.code === "maxlag" || apiError.code === "ratelimited") {
        lastError = `API ${apiError.code} (${apiError.info ?? "?"})`;
        continue;
      }
      throw new Error(
        `API error ${apiError.code ?? "?"} (${apiError.info ?? "?"})`,
      );
    }
    return body;
  }
  throw new Error(`${lastError} (retries exhausted) at ${full}`);
}

// ---------------------------------------------------------------------------
// Commons photos: per-file license re-check.
// ---------------------------------------------------------------------------

interface CommonsExtmetadata {
  readonly LicenseShortName?: { readonly value?: string };
  readonly LicenseUrl?: { readonly value?: string };
}

interface CommonsPage {
  readonly title?: string;
  readonly missing?: boolean;
  readonly imageinfo?: readonly { readonly extmetadata?: CommonsExtmetadata }[];
}

interface CommonsQueryResponse {
  readonly query?: {
    readonly normalized?: readonly {
      readonly from?: string;
      readonly to?: string;
    }[];
    readonly pages?: readonly CommonsPage[];
  };
}

/** Lowercase, collapse whitespace, treat "CC0 1.0" and "CC0" alike. */
function normalizeLicenseName(name: string | null | undefined): string {
  return (name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^cc0 1\.0$/, "cc0");
}

/** Case/http/trailing-slash/"deed" suffix-insensitive license URL. */
function normalizeLicenseUrl(url: string | null | undefined): string {
  return (url ?? "")
    .trim()
    .toLowerCase()
    .replace(/^http:\/\//, "https://")
    .replace(/\/deed(\.[a-z_]+)?$/, "")
    .replace(/\/+$/, "");
}

/**
 * A photo's committed license still holds when Commons reports the same
 * license short name OR the same license URL (deeds move and short names
 * vary in formatting; either match counts as unchanged).
 */
function licenseUnchanged(
  photo: RawCommonsPhoto,
  meta: CommonsExtmetadata | undefined,
): boolean {
  const liveName = normalizeLicenseName(meta?.LicenseShortName?.value);
  const liveUrl = normalizeLicenseUrl(meta?.LicenseUrl?.value);
  if (liveName !== "" && liveName === normalizeLicenseName(photo.license)) {
    return true;
  }
  return (
    liveUrl !== "" &&
    photo.licenseUrl !== null &&
    liveUrl === normalizeLicenseUrl(photo.licenseUrl)
  );
}

/**
 * Batched imageinfo lookup over every unique file name in
 * commons-photos.json (20 titles per request keeps URLs sane).
 */
async function verifyPhotoLicenses(failures: string[]): Promise<void> {
  const doc: unknown = JSON.parse(readFileSync(RAW_PHOTOS_PATH, "utf8"));
  assertRawCommonsPhotosDoc(doc);

  const byFile = new Map<string, { placeId: string; photo: RawCommonsPhoto }>();
  for (const place of doc.places) {
    for (const photo of place.photos) {
      byFile.set(photo.file, { placeId: place.id, photo });
    }
  }
  const files = [...byFile.keys()];
  const BATCH = 20;
  let checked = 0;
  for (let start = 0; start < files.length; start += BATCH) {
    if (start > 0) await sleep(DELAY_MS);
    const batch = files.slice(start, start + BATCH);
    const titles = batch
      .map((file) => encodeURIComponent(`File:${file}`))
      .join("|");
    const url =
      "https://commons.wikimedia.org/w/api.php?action=query&format=json" +
      "&formatversion=2&prop=imageinfo&iiprop=extmetadata" +
      `&titles=${titles}`;
    let body: CommonsQueryResponse;
    try {
      body = (await apiGet(url, true)) as CommonsQueryResponse;
    } catch (error) {
      failures.push(
        `Commons imageinfo batch failed (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    const pagesList = body.query?.pages;
    if (!Array.isArray(pagesList)) {
      failures.push(
        `Commons imageinfo batch returned no pages array (${batch.length} titles unchecked)`,
      );
      continue;
    }
    // The API may normalize a requested title (e.g. underscores back to
    // spaces) — follow the "normalized" map so a normalized-away title is
    // not mistaken for a deleted file.
    const normalized = new Map<string, string>();
    for (const n of body.query?.normalized ?? []) {
      if (typeof n.from === "string" && typeof n.to === "string") {
        normalized.set(n.from, n.to);
      }
    }
    const pages = new Map(
      pagesList
        .filter((page) => typeof page.title === "string")
        .map((page) => [page.title as string, page]),
    );
    for (const file of batch) {
      const entry = byFile.get(file);
      if (!entry) continue;
      const requested = `File:${file}`;
      const page = pages.get(normalized.get(requested) ?? requested);
      const what = `${entry.placeId} photo ${entry.photo.file}`;
      if (!page || page.missing === true) {
        failures.push(`${what}: file no longer exists on Commons`);
        continue;
      }
      const meta = page.imageinfo?.[0]?.extmetadata;
      if (!licenseUnchanged(entry.photo, meta)) {
        failures.push(
          `${what}: license changed (${entry.photo.license} -> ` +
            `${meta?.LicenseShortName?.value ?? "?"})`,
        );
      }
      checked += 1;
    }
  }
  console.log(`checked ${checked}/${files.length} Commons file licenses`);
}

// ---------------------------------------------------------------------------
// es.wikipedia extracts: each committed revision id must still resolve.
// ---------------------------------------------------------------------------

interface WikipediaRevisionResponse {
  readonly badrevids?:
    | Record<string, { readonly revid?: number }>
    | readonly { readonly revid?: number }[];
  readonly query?: {
    readonly pages?: readonly {
      readonly revisions?: readonly { readonly revid?: number }[];
    }[];
  };
}

async function verifyExtractRevisions(failures: string[]): Promise<void> {
  const doc: unknown = JSON.parse(readFileSync(RAW_EXTRACTS_PATH, "utf8"));
  assertRawWikipediaExtractsDoc(doc);

  // revids accepts up to 50 ids per request, so all 35 extracts are
  // checked in one round-trip — gentle on the es.wikipedia rate limit.
  const revids = doc.places.map((e) => e.revision);
  const url =
    "https://es.wikipedia.org/w/api.php?action=query&format=json" +
    "&formatversion=2&prop=revisions&rvprop=ids" +
    `&revids=${revids.join("|")}`;
  let body: WikipediaRevisionResponse;
  try {
    body = (await apiGet(url, true)) as WikipediaRevisionResponse;
  } catch (error) {
    for (const extract of doc.places) {
      failures.push(
        `${extract.id} (${extract.title}) rev ${extract.revision}: ` +
          `fetch failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    return;
  }
  const found = new Set<number>();
  for (const page of body.query?.pages ?? []) {
    for (const rev of page.revisions ?? []) {
      if (typeof rev.revid === "number") found.add(rev.revid);
    }
  }
  const bad = body.badrevids;
  const badIds = new Set<number>();
  if (Array.isArray(bad)) {
    for (const b of bad) {
      if (typeof b.revid === "number") badIds.add(b.revid);
    }
  } else if (bad !== null && typeof bad === "object") {
    for (const key of Object.keys(bad)) badIds.add(Number(key));
  }
  for (const extract of doc.places) {
    const revision = Number(extract.revision);
    const what = `${extract.id} (${extract.title}) rev ${extract.revision}`;
    if (badIds.has(revision) || !found.has(revision)) {
      failures.push(`${what}: the revision no longer resolves on es.wikipedia`);
    }
  }
  console.log(`checked ${doc.places.length} extract revisions`);
}

async function main(): Promise<void> {
  const doc: unknown = JSON.parse(readFileSync(RAW_PATH, "utf8"));
  assertRawPlacesDoc(doc);

  const failures: string[] = [];
  const notes: string[] = [];

  for (const [k, place] of doc.places.entries()) {
    if (k > 0) await sleep(DELAY_MS);
    const what = `${place.id} (${place.label.es ?? place.label.en ?? "?"})`;
    const url = `https://www.wikidata.org/wiki/Special:EntityData/${place.id}.json`;
    let entity: WikidataEntity | undefined;
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
      });
      if (!res.ok) {
        failures.push(`${what}: HTTP ${res.status} from ${url}`);
        continue;
      }
      const body = (await res.json()) as WikidataResponse;
      entity = body.entities?.[place.id];
      if (!entity) {
        failures.push(`${what}: entity missing from the response`);
        continue;
      }
    } catch (error) {
      failures.push(
        `${what}: fetch failed (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }

    const diffs = diffPlace(place, entity);
    failures.push(...diffs.map((d) => `${what}: ${d}`));
    if (
      typeof entity.lastrevid === "number" &&
      entity.lastrevid !== place.lastrevid
    ) {
      notes.push(
        `${what}: lastrevid moved ${place.lastrevid} -> ` +
          `${entity.lastrevid} (entity edited since the download)`,
      );
    }
    if ((k + 1) % 10 === 0 || k === doc.places.length - 1) {
      console.log(`checked ${k + 1}/${doc.places.length} entities`);
    }
  }

  await verifyPhotoLicenses(failures);
  await verifyExtractRevisions(failures);

  for (const note of notes) console.log(`note: ${note}`);

  if (failures.length > 0) {
    console.error(
      `FAIL: ${failures.length} difference(s) vs ` +
        `data/raw/places/wikidata-places.json:`,
    );
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(
    `OK: all ${doc.places.length} places match live Wikidata ` +
      `(labels, descriptions, coordinates, eswiki links)`,
  );
}

function diffPlace(place: RawWikidataPlace, entity: WikidataEntity): string[] {
  const diffs: string[] = [];
  const compare = (
    field: string,
    committed: string | null,
    live: string | null,
  ): void => {
    if (committed !== live) {
      diffs.push(
        `${field} is ${JSON.stringify(committed)} locally, ` +
          `${JSON.stringify(live)} on Wikidata`,
      );
    }
  };

  compare("label.es", place.label.es, labelValue(entity, "labels", "es"));
  compare("label.en", place.label.en, labelValue(entity, "labels", "en"));
  compare(
    "description.es",
    place.description.es,
    labelValue(entity, "descriptions", "es"),
  );
  compare(
    "description.en",
    place.description.en,
    labelValue(entity, "descriptions", "en"),
  );

  const liveCoord = coordinateValue(entity);
  if (liveCoord === null) {
    diffs.push("P625 coordinate is missing or unreadable on Wikidata");
  } else {
    const dLat = Math.abs(liveCoord.lat - place.coordinates.lat);
    const dLon = Math.abs(liveCoord.lon - place.coordinates.lon);
    if (dLat > COORD_EPSILON || dLon > COORD_EPSILON) {
      diffs.push(
        `coordinates are ${place.coordinates.lat}, ` +
          `${place.coordinates.lon} locally, ` +
          `${liveCoord.lat}, ${liveCoord.lon} on Wikidata`,
      );
    }
    if (
      liveCoord.precision !== null &&
      place.coordinates.precision !== undefined &&
      place.coordinates.precision !== null &&
      Math.abs(liveCoord.precision - place.coordinates.precision) >
        COORD_EPSILON
    ) {
      diffs.push(
        `coordinate precision is ${place.coordinates.precision} locally, ` +
          `${liveCoord.precision} on Wikidata`,
      );
    }
  }

  compare("eswiki", place.eswiki, sitelinkTitle(entity, "eswiki"));
  return diffs;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
