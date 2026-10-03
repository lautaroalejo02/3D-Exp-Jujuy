import { describe, expect, it } from "vitest";

import { gridToLonLat, type GridSpec } from "../geo/grid";
import { DEM_GRID } from "../geo/jujuy";
import { encodeHeightsLE } from "./encoding";
import {
  Heightfield,
  loadHeightfield,
  loadTerrainManifest,
  TerrainHttpError,
  TerrainManifestError,
  type FetchLike,
  type FetchResponseLike,
} from "./heightfield";
import type { TerrainManifest } from "./manifest";
import { TERRAIN_SCHEMA_VERSION } from "./manifest";
import { GridExtentMismatchError } from "./validate";

// 3x3 synthetic grid inside the DEM extent so lon/lat math stays realistic.
// heights[j*3+i] = i*100 + j*1000.
const SPEC: GridSpec = {
  zoom: 10,
  originPx: [320 * 256 + 128, 575 * 256],
  width: 3,
  height: 3,
  scale: 1,
};
const HEIGHTS = new Float32Array([0, 100, 200, 1000, 1100, 1200, 2000, 2100, 2200]);

function makeField(): Heightfield {
  return new Heightfield(HEIGHTS, SPEC);
}

describe("Heightfield", () => {
  it("rejects data that does not match the spec dimensions", () => {
    expect(() => new Heightfield(new Float32Array(4), SPEC)).toThrow();
  });

  it("returns exact values at cell centers", () => {
    const hf = makeField();
    expect(hf.heightAtGrid(0, 0)).toBe(0);
    expect(hf.heightAtGrid(1, 1)).toBe(1100);
    expect(hf.heightAtGrid(2, 2)).toBe(2200);
  });

  it("interpolates bilinearly between samples", () => {
    const hf = makeField();
    expect(hf.heightAtGrid(0.5, 0)).toBe(50);
    expect(hf.heightAtGrid(0.5, 0.5)).toBe(550);
    expect(hf.heightAtGrid(0.25, 1)).toBe(1025);
  });

  it("clamps to border samples outside the grid", () => {
    const hf = makeField();
    expect(hf.heightAtGrid(-5, 0)).toBe(0);
    expect(hf.heightAtGrid(10, 10)).toBe(2200);
    expect(hf.heightAtGrid(2, -1)).toBe(200);
  });

  it("exposes min and max", () => {
    const hf = makeField();
    expect(hf.min).toBe(0);
    expect(hf.max).toBe(2200);
  });

  it("accepts Int16 input", () => {
    const hf = new Heightfield(new Int16Array([1, 2, 3, 4]), {
      ...SPEC,
      width: 2,
      height: 2,
    });
    expect(hf.heightAtGrid(0.5, 0.5)).toBeCloseTo(2.5, 9);
  });

  it("maps lon/lat through the grid spec", () => {
    const hf = makeField();
    const [lon, lat] = gridToLonLat(SPEC, 1, 1);
    expect(hf.heightAtLonLat(lon, lat)).toBeCloseTo(1100, 6);
  });

  it("returns undefined for lon/lat outside the grid", () => {
    const hf = makeField();
    expect(hf.heightAtLonLat(0, 0)).toBeUndefined();
    const [east] = gridToLonLat(SPEC, SPEC.width, 0);
    expect(hf.heightAtLonLat(east + 1, -23)).toBeUndefined();
  });

  describe("sampleAlong", () => {
    it("returns n samples with endpoints at a and b", () => {
      const hf = makeField();
      const a = gridToLonLat(SPEC, 0, 0);
      const b = gridToLonLat(SPEC, 2, 0);
      const samples = hf.sampleAlong(a, b, 3);
      expect(samples).toHaveLength(3);
      expect(samples[0]?.lon).toBeCloseTo(a[0] ?? 0, 9);
      expect(samples[0]?.lat).toBeCloseTo(a[1] ?? 0, 9);
      expect(samples[2]?.lon).toBeCloseTo(b[0] ?? 0, 9);
      expect(samples[2]?.lat).toBeCloseTo(b[1] ?? 0, 9);
      expect(samples.map((s) => s.elevationMeters)).toEqual([0, 100, 200]);
    });

    it("accumulates ground distance in meters", () => {
      const hf = makeField();
      const a = gridToLonLat(SPEC, 0, 0);
      const b = gridToLonLat(SPEC, 2, 0);
      const samples = hf.sampleAlong(a, b, 5);
      expect(samples[0]?.distanceMeters).toBe(0);
      for (let k = 1; k < samples.length; k++) {
        expect(samples[k]?.distanceMeters ?? 0).toBeGreaterThan(
          samples[k - 1]?.distanceMeters ?? 0,
        );
      }
      // Equal steps -> the midpoint lands at half the total distance.
      const last = samples[samples.length - 1]?.distanceMeters ?? 0;
      expect(samples[2]?.distanceMeters ?? 0).toBeCloseTo(last / 2, 6);
      // At z10 (~152.9 mercator m/px) and ~23 deg S, two cells ~= 281 m.
      expect(last).toBeGreaterThan(200);
      expect(last).toBeLessThan(400);
    });

    it("marks samples outside the grid with undefined elevation", () => {
      const hf = makeField();
      const inside = gridToLonLat(SPEC, 0, 0);
      const samples = hf.sampleAlong(inside, [0, 0], 4);
      expect(samples[0]?.elevationMeters).toBeDefined();
      expect(samples[3]?.elevationMeters).toBeUndefined();
    });

    it("returns an empty array for n < 1", () => {
      expect(makeField().sampleAlong([0, 0], [1, 1], 0)).toEqual([]);
    });
  });
});

function fakeResponse(body: unknown, status = 200): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    arrayBuffer: () =>
      Promise.resolve(
        body instanceof Uint8Array
          ? new Uint8Array(body).buffer
          : (body as ArrayBuffer),
      ),
  };
}

function stubManifest(heightsFile = "heights.bin"): TerrainManifest {
  return {
    schemaVersion: TERRAIN_SCHEMA_VERSION,
    pipelineVersion: 1,
    levels: {
      default: {
        heights: {
          file: heightsFile,
          bytes: 18,
          sha256: "x".repeat(64),
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
        },
        satellite: {
          file: "sat.jpg",
          bytes: 1,
          sha256: "y".repeat(64),
          grid: SPEC,
        },
      },
      high: {
        heights: {
          file: "heights-full.bin",
          bytes: 18,
          sha256: "z".repeat(64),
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
        },
        satellite: {
          file: "sat-full.jpg",
          bytes: 1,
          sha256: "w".repeat(64),
          grid: SPEC,
        },
      },
    },
    sources: {
      dem: { file: "dem.png", path: "data/raw/dem.png", bytes: 1, sha256: "d".repeat(64) },
      satellite: {
        file: "sat.jpg",
        path: "data/raw/sat.jpg",
        bytes: 1,
        sha256: "s".repeat(64),
      },
      attribution: "see ATTRIBUTIONS.md",
    },
  };
}

describe("loadTerrainManifest", () => {
  it("fetches and validates the manifest", async () => {
    const fetchFn: FetchLike = (url) => {
      expect(url).toBe("terrain.json");
      return Promise.resolve(fakeResponse(stubManifest()));
    };
    const manifest = await loadTerrainManifest(fetchFn);
    expect(manifest.schemaVersion).toBe(TERRAIN_SCHEMA_VERSION);
    expect(manifest.levels.default.heights.file).toBe("heights.bin");
  });

  it("throws TerrainHttpError on HTTP failure", async () => {
    const fetchFn: FetchLike = () => Promise.resolve(fakeResponse({}, 404));
    await expect(loadTerrainManifest(fetchFn)).rejects.toBeInstanceOf(TerrainHttpError);
    await expect(loadTerrainManifest(fetchFn)).rejects.toMatchObject({
      status: 404,
      url: "terrain.json",
    });
  });

  it("throws TerrainManifestError on a bad payload", async () => {
    const fetchFn: FetchLike = () => Promise.resolve(fakeResponse({ hello: 1 }));
    await expect(loadTerrainManifest(fetchFn)).rejects.toBeInstanceOf(
      TerrainManifestError,
    );
  });
});

describe("loadHeightfield", () => {
  it("decodes the Int16 payload into a Heightfield", async () => {
    const payload = encodeHeightsLE(HEIGHTS);
    const fetchFn: FetchLike = (url) => {
      expect(url).toBe("data/heights.bin");
      return Promise.resolve(fakeResponse(payload));
    };
    const hf = await loadHeightfield(stubManifest(), "default", fetchFn, "data/");
    expect(hf.spec).toEqual(SPEC);
    expect(hf.heightAtGrid(2, 2)).toBe(2200);
    expect(hf.min).toBe(0);
    expect(hf.max).toBe(2200);
  });

  it("uses the requested quality level", async () => {
    const payload = encodeHeightsLE(HEIGHTS);
    const fetchFn: FetchLike = (url) => {
      expect(url).toBe("heights-full.bin");
      return Promise.resolve(fakeResponse(payload));
    };
    const hf = await loadHeightfield(stubManifest(), "high", fetchFn);
    expect(hf.max).toBe(2200);
  });

  it("throws TerrainHttpError on HTTP failure", async () => {
    const fetchFn: FetchLike = () => Promise.resolve(fakeResponse({}, 500));
    await expect(
      loadHeightfield(stubManifest(), "default", fetchFn),
    ).rejects.toBeInstanceOf(TerrainHttpError);
  });

  it("throws when the payload size does not match the grid", async () => {
    const fetchFn: FetchLike = () =>
      Promise.resolve(fakeResponse(encodeHeightsLE([1, 2, 3, 4])));
    await expect(
      loadHeightfield(stubManifest(), "default", fetchFn),
    ).rejects.toThrow();
  });

  it("rejects a manifest whose height and satellite extents differ", async () => {
    const manifest = stubManifest();
    const shifted: GridSpec = {
      ...manifest.levels.default.satellite.grid,
      originPx: [
        manifest.levels.default.satellite.grid.originPx[0] + 1,
        manifest.levels.default.satellite.grid.originPx[1],
      ],
    };
    const mismatched: TerrainManifest = {
      ...manifest,
      levels: {
        ...manifest.levels,
        default: {
          ...manifest.levels.default,
          satellite: { ...manifest.levels.default.satellite, grid: shifted },
        },
      },
    };
    await expect(
      loadHeightfield(mismatched, "default", () =>
        Promise.resolve(fakeResponse(encodeHeightsLE(HEIGHTS))),
      ),
    ).rejects.toBeInstanceOf(GridExtentMismatchError);
  });
});

describe("DEM_GRID sanity", () => {
  it("the real DEM grid is 2432x2560 at scale 1", () => {
    expect(DEM_GRID.width).toBe(2432);
    expect(DEM_GRID.height).toBe(2560);
    expect(DEM_GRID.scale).toBe(1);
  });
});
