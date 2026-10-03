/**
 * Places pipeline: data/raw/places/wikidata-places.json ->
 * data/build/places.json.
 *
 * For every place it computes, from data already produced by
 * `npm run build:data` and `npm run build:detail` (never hand-written,
 * AGENTS.md):
 *
 * - the elevation: a bilinear sample of the FULL-resolution DEM
 *   (heights-full.bin), rounded to the meter — plus the detail-patch DEM
 *   sample when the point falls inside a patch; the output reports both
 *   and flags which one the card should use;
 * - the department name from departments-full.bin + departments.json
 *   (verbatim shapeName, or "Fuera de Jujuy").
 *
 * Names, descriptions, coordinates and links pass through from the raw
 * Wikidata extract (CC0); `npm run verify:places` re-checks them against
 * Wikidata. Region is excluded (no open-licensed source) and no Wikipedia
 * text is copied (CC BY-SA) — the article is only linked.
 *
 * Re-runnable and deterministic: no timestamps, stable key order. When
 * data/build/places.json already records the current PIPELINE_VERSION and
 * the hash of every input (raw extract + heights + department rasters +
 * detail manifest/heights), prints "up to date" and does nothing.
 * `--force` rebuilds.
 *
 * data/raw/ is only read here, never written.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { lonLatToGrid } from "../src/geo/grid";
import {
  departmentNameAt,
  loadDepartments,
} from "../src/terrain/departments";
import { loadDetailManifest } from "../src/terrain/detail-manifest";
import { decodeHeightsLE } from "../src/terrain/encoding";
import {
  Heightfield,
  loadHeightfield,
  loadTerrainManifest,
  type FetchResponseLike,
} from "../src/terrain/heightfield";
import {
  assertPlacesDoc,
  assertRawPlacesDoc,
  buildPlaceEntry,
  PLACES_SCHEMA_VERSION,
  type Place,
  type PlacesDoc,
} from "../src/terrain/places-manifest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RAW_PATH = join(ROOT, "data/raw/places/wikidata-places.json");
const BUILD_DIR = join(ROOT, "data/build");
const OUT_PATH = join(BUILD_DIR, "places.json");

/**
 * Output format version, written to places.json and part of the cache
 * key. Bump whenever the place fields or their derivation change.
 */
const PIPELINE_VERSION = 2;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** FetchLike over data/build/, same contract as render-snapshot's. */
const fileFetch = (url: string): Promise<FetchResponseLike> => {
  const path = join(BUILD_DIR, url);
  if (!existsSync(path)) {
    return Promise.resolve({
      ok: false,
      status: 404,
      json: () => Promise.resolve(undefined),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });
  }
  const bytes = readFileSync(path);
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(JSON.parse(bytes.toString("utf8")) as unknown),
    arrayBuffer: () =>
      Promise.resolve(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
      ),
  });
};

/**
 * Cache check: up to date when the previous places.json records the same
 * pipeline version and the same input hash (the hash covers every input
 * file, so any upstream rebuild invalidates it).
 */
function checkPreviousBuild(inputSha256: string): string | undefined {
  if (!existsSync(OUT_PATH)) return "places.json is missing";
  let previous: unknown;
  try {
    previous = JSON.parse(readFileSync(OUT_PATH, "utf8"));
  } catch {
    return "places.json is unreadable";
  }
  const doc = previous as {
    pipelineVersion?: unknown;
    inputSha256?: unknown;
  } | null;
  if (doc?.pipelineVersion !== PIPELINE_VERSION) {
    return (
      `pipeline version changed (places.json recorded ` +
        `${String(doc?.pipelineVersion)}, pipeline is ${PIPELINE_VERSION})`
    );
  }
  if (doc.inputSha256 !== inputSha256) {
    return "input hash changed";
  }
  return undefined;
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");

  const placesBytes = readFileSync(RAW_PATH);
  const rawDoc: unknown = JSON.parse(placesBytes.toString("utf8"));
  assertRawPlacesDoc(rawDoc);

  const hash = createHash("sha256");
  const hashFile = (path: string): Uint8Array => {
    const bytes = readFileSync(path);
    hash.update(bytes);
    return bytes;
  };
  hash.update(placesBytes);

  // Upstream inputs — the same loaders the app uses, over data/build.
  const manifest = await loadTerrainManifest(fileFetch);
  const heightfield = await loadHeightfield(manifest, "high", fileFetch);
  const departments = await loadDepartments(manifest, "high", fileFetch);
  hashFile(join(BUILD_DIR, manifest.levels.high.heights.file));
  const deptLevel = manifest.levels.high.departments;
  if (!deptLevel || !manifest.boundaries) {
    throw new Error(
      "terrain.json has no departments data — run npm run build:data",
    );
  }
  hashFile(join(BUILD_DIR, deptLevel.index.file));
  hashFile(join(BUILD_DIR, manifest.boundaries.file.file));

  // Detail patches are additive like in the app: no manifest, no detail
  // elevations — the base DEM still covers every place.
  const detailManifestPath = join(BUILD_DIR, "detail", "manifest.json");
  const detailHeightfields: { id: string; heightfield: Heightfield }[] = [];
  if (existsSync(detailManifestPath)) {
    hashFile(detailManifestPath);
    const detailManifest = await loadDetailManifest(fileFetch);
    for (const site of detailManifest.sites) {
      const heightsBytes = hashFile(
        join(BUILD_DIR, "detail", site.heights.file),
      );
      detailHeightfields.push({
        id: site.id,
        heightfield: new Heightfield(
          decodeHeightsLE(heightsBytes),
          site.heights.grid,
        ),
      });
    }
  } else {
    console.warn(
      "data/build/detail/manifest.json missing — places get DEM " +
        "elevations only (run npm run build:detail for patch elevations)",
    );
  }
  const inputSha256 = hash.digest("hex");

  if (!force) {
    const reason = checkPreviousBuild(inputSha256);
    if (reason === undefined) {
      console.log("up to date");
      return;
    }
    console.log(`${reason}; rebuilding`);
  }

  const places: Place[] = rawDoc.places.map((raw) => {
    const demElevationMeters = heightfield.heightAtLonLat(
      raw.coordinates.lon,
      raw.coordinates.lat,
    );
    if (demElevationMeters === undefined) {
      throw new Error(
        `${raw.id} (${raw.label.es ?? raw.label.en ?? "?"}) at ` +
          `${raw.coordinates.lat}, ${raw.coordinates.lon} falls outside ` +
          `the DEM grid — the place list needs reviewing`,
      );
    }
    let detailElevationMeters: number | undefined;
    let detailSiteId: string | undefined;
    for (const d of detailHeightfields) {
      const sample = d.heightfield.heightAtLonLat(
        raw.coordinates.lon,
        raw.coordinates.lat,
      );
      if (sample !== undefined) {
        detailElevationMeters = sample;
        detailSiteId = d.id;
        break;
      }
    }
    const [di, dj] = lonLatToGrid(
      departments.grid,
      raw.coordinates.lon,
      raw.coordinates.lat,
    );
    const entry = buildPlaceEntry(raw, {
      demElevationMeters,
      ...(detailElevationMeters !== undefined
        ? { detailElevationMeters }
        : {}),
      department: departmentNameAt(departments, di, dj),
    });
    if (detailSiteId !== undefined) {
      console.log(`  ${entry.id} inside detail patch "${detailSiteId}"`);
    }
    return entry;
  });

  const doc: PlacesDoc = {
    schemaVersion: PLACES_SCHEMA_VERSION,
    pipelineVersion: PIPELINE_VERSION,
    inputSha256,
    sources: {
      places: {
        provider: "Wikidata",
        license: "CC0 1.0",
        licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
        file: "data/raw/places/wikidata-places.json",
        sha256: sha256(placesBytes),
      },
      elevation: {
        provider:
          "Terrain Tiles (Mapzen / AWS Open Data, Terrarium format; " +
          "SRTM/GMTED2010/ETOPO1)",
        file: "data/build/heights-full.bin",
        detailFiles: "data/build/detail/*/heights.bin",
        note:
          "Bilinear sample of the full-resolution DEM; when the point " +
          "falls inside a detail patch the patch's DEM sample is also " +
          "reported and preferred by the UI. Rounded to the meter.",
      },
      boundaries: {
        provider:
          "geoBoundaries gbOpen, Argentina ADM2 (Instituto Geográfico " +
          "Nacional / UNHCR, OCHA ROLAC)",
        license: "CC BY 3.0 IGO",
        file: "data/build/departments.json",
      },
    },
    places,
  };

  mkdirSync(BUILD_DIR, { recursive: true });
  const out = JSON.stringify(doc, null, 2) + "\n";
  // Sanity: the file we just serialized must satisfy the client schema.
  assertPlacesDoc(JSON.parse(out));
  writeFileSync(OUT_PATH, out);

  console.log("data/build/places.json written:");
  for (const place of places) {
    const detailTag =
      place.elevationSource === "detail-dem" ? " (detail DEM)" : "";
    console.log(
      `  ${place.id} ${place.name}: ${place.elevationMeters} m` +
        `${detailTag} · ${place.department}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
