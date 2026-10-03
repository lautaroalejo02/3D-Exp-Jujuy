import type { TerrainFileEntry, TerrainManifest } from "./manifest";

/** Size + content hash of a file on disk, as the manifest records it. */
export interface CacheFileState {
  readonly bytes: number;
  readonly sha256: string;
}

export type BuildCacheVerdict =
  | { readonly upToDate: true }
  | { readonly upToDate: false; readonly reason: string };

/**
 * Pure "is data/build still fresh?" decision for scripts/build-data.ts.
 *
 * Up to date requires all of: the manifest's input hashes match the current
 * raw files, the recorded pipelineVersion matches the script's, and every
 * output file listed in the manifest exists on disk with the recorded byte
 * size and sha256 (debug artifacts like debug-alignment.png and snapshots
 * are not manifest outputs and are not checked). Any mismatch returns the
 * failed check in `reason` so the caller can log it and rebuild.
 *
 * `fileState` resolves a manifest-listed file name to its on-disk
 * size+sha256, or undefined when the file does not exist; it is only
 * consulted after the cheap checks pass.
 */
export function checkBuildCache(
  previousManifest: unknown,
  expected: {
    readonly pipelineVersion: number;
    readonly demSha256: string;
    readonly satelliteSha256: string;
  },
  fileState: (file: string) => CacheFileState | undefined,
): BuildCacheVerdict {
  const fail = (reason: string): BuildCacheVerdict => ({
    upToDate: false,
    reason,
  });

  const m = previousManifest as TerrainManifest | null | undefined;
  if (!m || typeof m !== "object") {
    return fail("terrain.json is missing or unreadable");
  }
  if (m.sources?.dem?.sha256 !== expected.demSha256) {
    return fail("DEM input hash changed");
  }
  if (m.sources?.satellite?.sha256 !== expected.satelliteSha256) {
    return fail("satellite input hash changed");
  }
  if (m.pipelineVersion !== expected.pipelineVersion) {
    return fail(
      `pipeline version changed (terrain.json recorded ` +
        `${String(m.pipelineVersion)}, pipeline is ${expected.pipelineVersion})`,
    );
  }

  const entries: readonly (TerrainFileEntry | undefined)[] = [
    m.levels?.default?.heights,
    m.levels?.default?.satellite,
    m.levels?.high?.heights,
    m.levels?.high?.satellite,
  ];
  const checked = new Set<string>();
  for (const entry of entries) {
    if (
      typeof entry?.file !== "string" ||
      typeof entry.bytes !== "number" ||
      typeof entry.sha256 !== "string"
    ) {
      return fail("terrain.json does not list every build output");
    }
    if (checked.has(entry.file)) continue;
    checked.add(entry.file);
    const actual = fileState(entry.file);
    if (!actual) {
      return fail(`missing output ${entry.file}`);
    }
    if (actual.bytes !== entry.bytes) {
      return fail(
        `${entry.file} is ${actual.bytes} B on disk, ` +
          `manifest recorded ${entry.bytes} B`,
      );
    }
    if (actual.sha256 !== entry.sha256) {
      return fail(`${entry.file} sha256 does not match the manifest`);
    }
  }
  return { upToDate: true };
}
