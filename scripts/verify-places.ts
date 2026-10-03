/**
 * Re-checks the committed Wikidata extract against live Wikidata: for
 * every place in data/raw/places/wikidata-places.json the entity is
 * fetched once more (Special:EntityData) and its label.es/en,
 * description.es/en, P625 coordinate and eswiki sitelink are compared
 * with the committed record. lastrevid differences are reported as
 * informational notes — entities legitimately change after the download
 * — while content differences and fetch failures are failures.
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
  assertRawPlacesDoc,
  type RawWikidataPlace,
} from "../src/terrain/places-manifest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RAW_PATH = join(ROOT, "data/raw/places/wikidata-places.json");

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
