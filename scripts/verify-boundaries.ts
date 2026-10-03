/**
 * Verifies the committed boundaries extract
 * data/raw/geoBoundaries-ARG-ADM2-jujuy.geojson against the pinned
 * upstream file:
 *
 * 1. downloads the geoBoundaries gbOpen Argentina ADM2 file recorded in
 *    the extract's `provenance.sourceUrl` (pinned release commit),
 * 2. checks the download's size and sha256 against the recorded
 *    `provenance.fullFile`,
 * 3. re-runs the same department selection in memory (the pure
 *    selectJujuyDepartments / connectedComponents in
 *    src/terrain/department-selection.ts) and
 * 4. deep-compares the selected features (geometry + properties) and
 *    the provenance's department list with the committed extract.
 *
 * Writes nothing — everything happens in memory (`data/raw/` is
 * read-only, AGENTS.md). Prints OK on success, or a precise diff
 * summary, and exits non-zero on any mismatch.
 *
 * Run: `npm run verify:boundaries`.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { gridExtentLonLat } from "../src/geo/grid";
import { DEM_GRID } from "../src/geo/jujuy";
import {
  connectedComponents,
  selectJujuyDepartments,
} from "../src/terrain/department-selection";
import {
  JUJUY_DEPARTMENT_NAMES,
  normalizeDepartmentName,
  type BBoxLonLat,
  type GeoJsonFeature,
} from "../src/terrain/raster-vector";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXTRACT_PATH = join(
  ROOT,
  "data/raw/geoBoundaries-ARG-ADM2-jujuy.geojson",
);

const DEM_EXTENT: BBoxLonLat = gridExtentLonLat(DEM_GRID);

/** Diff lines reported per mismatching feature — enough to locate it. */
const MAX_DIFF_LINES = 15;

interface ExtractDoc {
  readonly type: "FeatureCollection";
  readonly provenance: {
    readonly sourceUrl: string;
    readonly releaseCommit: string;
    readonly fullFile: { readonly bytes: number; readonly sha256: string };
    readonly selection: {
      readonly demExtentLonLat: BBoxLonLat;
      readonly departments: readonly {
        readonly index: number;
        readonly name: string;
        readonly sourceName: string;
        readonly shapeID: unknown;
      }[];
    };
  };
  readonly features: readonly GeoJsonFeature[];
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Reads and shape-checks the committed extract: FeatureCollection with a
 * features array and the provenance fields this verification relies on.
 */
function readCommittedExtract(path: string): ExtractDoc {
  const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const problems: string[] = [];
  if (doc.type !== "FeatureCollection") {
    problems.push("type is not \"FeatureCollection\"");
  }
  if (!Array.isArray(doc.features)) {
    problems.push("features is not an array");
  }
  const prov = doc.provenance;
  if (!isRecord(prov)) {
    problems.push("provenance is missing");
  } else {
    if (typeof prov.sourceUrl !== "string") {
      problems.push("provenance.sourceUrl is missing");
    }
    if (typeof prov.releaseCommit !== "string") {
      problems.push("provenance.releaseCommit is missing");
    }
    const full = prov.fullFile;
    if (!isRecord(full) || typeof full.sha256 !== "string" || typeof full.bytes !== "number") {
      problems.push("provenance.fullFile is missing {bytes, sha256}");
    }
    const sel = prov.selection;
    if (!isRecord(sel) || !Array.isArray(sel.demExtentLonLat) || !Array.isArray(sel.departments)) {
      problems.push("provenance.selection is missing {demExtentLonLat, departments}");
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `${path} is not a valid boundaries extract:\n  ${problems.join("\n  ")}`,
    );
  }
  return doc as unknown as ExtractDoc;
}

function parseFeatureCollection(text: string): { features: GeoJsonFeature[] } {
  const gj = JSON.parse(text) as { type?: unknown; features?: unknown };
  if (gj?.type !== "FeatureCollection" || !Array.isArray(gj.features)) {
    throw new Error("downloaded file is not a GeoJSON FeatureCollection");
  }
  for (const f of gj.features as GeoJsonFeature[]) {
    if (f?.type !== "Feature" || !f.geometry || !f.properties) {
      throw new Error("downloaded file has a malformed feature");
    }
    if (f.properties.shapeGroup !== "ARG" || f.properties.shapeType !== "ADM2") {
      throw new Error(
        `unexpected feature scope: expected ARG ADM2, got ` +
          `${String(f.properties.shapeGroup)} ${String(f.properties.shapeType)}`,
      );
    }
  }
  return gj as { features: GeoJsonFeature[] };
}

async function downloadSource(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

function shortJson(value: unknown): string {
  const s = JSON.stringify(value) ?? String(value);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

/**
 * Recursive structural diff: appends `path: committed != re-extracted`
 * lines to `out`, capped at MAX_DIFF_LINES. Equal subtrees short-circuit
 * through isDeepStrictEqual, so only the differing leaves are reported.
 */
function collectDiffs(
  committed: unknown,
  extracted: unknown,
  path: string,
  out: string[],
): void {
  if (out.length >= MAX_DIFF_LINES) return;
  if (isDeepStrictEqual(committed, extracted)) return;
  if (Array.isArray(committed) && Array.isArray(extracted)) {
    if (committed.length !== extracted.length) {
      out.push(`${path}: length ${committed.length} != ${extracted.length}`);
    }
    const n = Math.min(committed.length, extracted.length);
    for (let i = 0; i < n && out.length < MAX_DIFF_LINES; i++) {
      collectDiffs(committed[i], extracted[i], `${path}[${i}]`, out);
    }
    return;
  }
  if (isRecord(committed) && isRecord(extracted)) {
    const keys = [
      ...new Set([...Object.keys(committed), ...Object.keys(extracted)]),
    ];
    for (const key of keys) {
      if (out.length >= MAX_DIFF_LINES) return;
      if (!(key in committed)) {
        out.push(`${path}.${key}: missing from the committed extract`);
      } else if (!(key in extracted)) {
        out.push(`${path}.${key}: missing from the re-extracted feature`);
      } else {
        collectDiffs(committed[key], extracted[key], `${path}.${key}`, out);
      }
    }
    return;
  }
  out.push(
    `${path}: committed ${shortJson(committed)} != re-extracted ${shortJson(extracted)}`,
  );
}

async function main(): Promise<void> {
  const committed = readCommittedExtract(EXTRACT_PATH);
  const prov = committed.provenance;
  const failures: string[] = [];

  // 1. Download the pinned upstream file and check the recorded hashes.
  const bytes = await downloadSource(prov.sourceUrl);
  const fullSha = sha256(bytes);
  if (bytes.length !== prov.fullFile.bytes) {
    failures.push(
      `full file size: provenance recorded ${prov.fullFile.bytes} B, ` +
        `downloaded ${bytes.length} B`,
    );
  }
  if (fullSha !== prov.fullFile.sha256) {
    failures.push(
      `full file sha256: provenance recorded ${prov.fullFile.sha256}, ` +
        `downloaded ${fullSha}`,
    );
  }

  // 2. The recorded selection extent must be the DEM grid extent.
  if (!isDeepStrictEqual(prov.selection.demExtentLonLat, DEM_EXTENT)) {
    failures.push(
      `provenance.selection.demExtentLonLat ${shortJson(prov.selection.demExtentLonLat)} ` +
        `!= DEM grid extent ${shortJson(DEM_EXTENT)}`,
    );
  }

  // 3. Re-run the selection in memory on the downloaded features.
  const gj = parseFeatureCollection(Buffer.from(bytes).toString("utf8"));
  const selected = selectJujuyDepartments(gj.features, DEM_EXTENT);
  if (selected.length !== JUJUY_DEPARTMENT_NAMES.length) {
    failures.push(
      `re-selection produced ${selected.length} departments, expected ` +
        JUJUY_DEPARTMENT_NAMES.length,
    );
  }
  // Stable index order: sorted by normalized source name (shapeName).
  const ordered = [...selected].sort((a, b) =>
    a.nameKey.localeCompare(b.nameKey),
  );

  const components = connectedComponents(ordered.map((d) => d.polygons));
  if (components !== 1) {
    failures.push(
      `re-selected departments are not contiguous (${components} ` +
        `connected components)`,
    );
  }

  // 4a. The committed feature list must equal the re-extracted one,
  // geometry and properties included.
  if (committed.features.length !== ordered.length) {
    failures.push(
      `feature count: committed ${committed.features.length}, ` +
        `re-extracted ${ordered.length}`,
    );
  }
  const pairs = Math.min(committed.features.length, ordered.length);
  for (let k = 0; k < pairs; k++) {
    const a = committed.features[k] as GeoJsonFeature;
    const b = ordered[k]?.feature as GeoJsonFeature;
    if (isDeepStrictEqual(a, b)) continue;
    const name =
      (b.properties?.shapeName as string | undefined) ??
      (a.properties?.shapeName as string | undefined) ??
      `#${k + 1}`;
    const diffs: string[] = [];
    collectDiffs(a, b, `features[${k}]`, diffs);
    failures.push(
      `feature ${k + 1} "${name}" differs:\n    ${diffs.join("\n    ")}`,
    );
  }

  // 4b. The provenance department list must describe what we selected:
  // checklist name, verbatim source name and shapeID per index.
  const expectedNameByKey = new Map(
    JUJUY_DEPARTMENT_NAMES.map((n) => [normalizeDepartmentName(n), n]),
  );
  prov.selection.departments.forEach((d, k) => {
    const sel = ordered[k];
    if (!sel) return;
    const expected = {
      index: k + 1,
      name: expectedNameByKey.get(sel.nameKey) ?? sel.sourceName,
      sourceName: sel.sourceName,
      shapeID: sel.feature.properties?.shapeID ?? null,
    };
    const actual = {
      index: d.index,
      name: d.name,
      sourceName: d.sourceName,
      shapeID: d.shapeID,
    };
    if (!isDeepStrictEqual(actual, expected)) {
      failures.push(
        `provenance.selection.departments[${k}]: recorded ` +
          `${shortJson(actual)} != expected ${shortJson(expected)}`,
      );
    }
  });
  if (prov.selection.departments.length !== ordered.length) {
    failures.push(
      `provenance.selection.departments has ` +
        `${prov.selection.departments.length} entries, expected ${ordered.length}`,
    );
  }

  if (failures.length > 0) {
    console.error(
      `FAIL: ${EXTRACT_PATH} does not match the pinned upstream source:`,
    );
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log(
    `OK: data/raw/geoBoundaries-ARG-ADM2-jujuy.geojson matches the pinned ` +
      `upstream source`,
  );
  console.log(`  source: ${prov.sourceUrl} (release ${prov.releaseCommit})`);
  console.log(
    `  full file: ${bytes.length} B, sha256 ${fullSha.slice(0, 12)}… ` +
      `(verified against provenance)`,
  );
  console.log(
    `  re-selected ${ordered.length}/${JUJUY_DEPARTMENT_NAMES.length} ` +
      `departments, contiguous: yes, features identical (geometry + properties)`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
