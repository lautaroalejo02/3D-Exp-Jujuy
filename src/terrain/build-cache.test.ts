import { describe, expect, it } from "vitest";

import type { GridSpec } from "../geo/grid";
import { checkBuildCache, type CacheFileState } from "./build-cache";
import type { TerrainManifest } from "./manifest";

const EXPECTED = {
  pipelineVersion: 2,
  demSha256: "d".repeat(64),
  satelliteSha256: "s".repeat(64),
};

const SPEC: GridSpec = {
  zoom: 10,
  originPx: [82048, 147200],
  width: 3,
  height: 3,
  scale: 1,
};

/** Recorded output entries: file name -> size + hash the manifest claims. */
const OUTPUTS: Record<string, CacheFileState> = {
  "heights-half.bin": { bytes: 18, sha256: "a".repeat(64) },
  "satellite-half.jpg": { bytes: 20, sha256: "b".repeat(64) },
  "heights-full.bin": { bytes: 18, sha256: "c".repeat(64) },
  "satellite-full.jpg": { bytes: 40, sha256: "e".repeat(64) },
};

function stubManifest(): TerrainManifest {
  const entry = (file: string): TerrainManifest["levels"]["default"]["heights"] => ({
    file,
    bytes: OUTPUTS[file]?.bytes ?? 0,
    sha256: OUTPUTS[file]?.sha256 ?? "",
    grid: SPEC,
    encoding: {
      format: "int16",
      endianness: "little",
      units: "meters",
      layout: "row-major",
    },
    elevation: {
      minMeters: 0,
      maxMeters: 2200,
      meanMeters: 1100,
      p001Meters: 0,
      p999Meters: 2200,
    },
  });
  const sat = (file: string): TerrainManifest["levels"]["default"]["satellite"] => ({
    file,
    bytes: OUTPUTS[file]?.bytes ?? 0,
    sha256: OUTPUTS[file]?.sha256 ?? "",
    grid: SPEC,
  });
  return {
    schemaVersion: 1,
    pipelineVersion: EXPECTED.pipelineVersion,
    levels: {
      default: {
        heights: entry("heights-half.bin"),
        satellite: sat("satellite-half.jpg"),
      },
      high: {
        heights: entry("heights-full.bin"),
        satellite: sat("satellite-full.jpg"),
      },
    },
    sources: {
      dem: {
        file: "dem.png",
        path: "data/raw/dem.png",
        bytes: 1,
        sha256: EXPECTED.demSha256,
      },
      satellite: {
        file: "sat.jpg",
        path: "data/raw/sat.jpg",
        bytes: 1,
        sha256: EXPECTED.satelliteSha256,
      },
      attribution: "see ATTRIBUTIONS.md",
    },
  };
}

/** All four outputs on disk, matching the manifest records. */
function allPresent(): (file: string) => CacheFileState | undefined {
  return (file) => OUTPUTS[file];
}

function check(
  manifest: unknown = stubManifest(),
  fileState: (file: string) => CacheFileState | undefined = allPresent(),
  expected: typeof EXPECTED = EXPECTED,
) {
  return checkBuildCache(manifest, expected, fileState);
}

describe("checkBuildCache", () => {
  it("reports up to date when inputs, version and every output match", () => {
    expect(check()).toEqual({ upToDate: true });
  });

  it("rebuilds when the previous manifest is missing", () => {
    expect(check(null).upToDate).toBe(false);
    expect(check("{not json").upToDate).toBe(false);
  });

  it("rebuilds when the DEM input hash changed", () => {
    const m = stubManifest();
    const verdict = check(m, allPresent(), {
      ...EXPECTED,
      demSha256: "0".repeat(64),
    });
    expect(verdict).toMatchObject({ upToDate: false });
    if (!verdict.upToDate) expect(verdict.reason).toMatch(/DEM/);
  });

  it("rebuilds when the satellite input hash changed", () => {
    const verdict = check(stubManifest(), allPresent(), {
      ...EXPECTED,
      satelliteSha256: "0".repeat(64),
    });
    expect(verdict).toMatchObject({ upToDate: false });
    if (!verdict.upToDate) expect(verdict.reason).toMatch(/satellite/);
  });

  it("rebuilds when the pipeline version changed", () => {
    const verdict = check(stubManifest(), allPresent(), {
      ...EXPECTED,
      pipelineVersion: EXPECTED.pipelineVersion + 1,
    });
    expect(verdict).toMatchObject({ upToDate: false });
    if (!verdict.upToDate) expect(verdict.reason).toMatch(/pipeline/i);
  });

  it("rebuilds when a manifest-listed output is missing", () => {
    const verdict = check(stubManifest(), (file) =>
      file === "heights-half.bin" ? undefined : OUTPUTS[file],
    );
    expect(verdict).toMatchObject({ upToDate: false });
    if (!verdict.upToDate) {
      expect(verdict.reason).toMatch(/heights-half\.bin/);
    }
  });

  it("rebuilds when an output has the wrong byte size", () => {
    const verdict = check(stubManifest(), (file) =>
      file === "satellite-full.jpg"
        ? { bytes: 41, sha256: OUTPUTS["satellite-full.jpg"]?.sha256 ?? "" }
        : OUTPUTS[file],
    );
    expect(verdict).toMatchObject({ upToDate: false });
    if (!verdict.upToDate) {
      expect(verdict.reason).toMatch(/satellite-full\.jpg/);
    }
  });

  it("rebuilds when an output sha256 differs (same-size corruption)", () => {
    const verdict = check(stubManifest(), (file) =>
      file === "heights-full.bin"
        ? { bytes: 18, sha256: "f".repeat(64) }
        : OUTPUTS[file],
    );
    expect(verdict).toMatchObject({ upToDate: false });
    if (!verdict.upToDate) {
      expect(verdict.reason).toMatch(/heights-full\.bin/);
    }
  });

  it("rebuilds when the manifest does not list every build output", () => {
    const m = stubManifest();
    const broken = {
      ...m,
      levels: { ...m.levels, high: undefined },
    };
    expect(check(broken).upToDate).toBe(false);
  });
});
