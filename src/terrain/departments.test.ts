import { describe, expect, it } from "vitest";

import type { GridSpec } from "../geo/grid";
import {
  DEPARTMENT_COUNT,
  DepartmentsDataError,
  loadDepartments,
} from "./departments";
import {
  TerrainHttpError,
  type FetchLike,
  type FetchResponseLike,
} from "./heightfield";
import type { TerrainManifest } from "./manifest";

/** 8-cell spec: 4x2 grid for both levels. */
const SPEC: GridSpec = {
  zoom: 10,
  originPx: [82048, 147200],
  width: 4,
  height: 2,
  scale: 1,
};

const CELLS = SPEC.width * SPEC.height;

function stubManifest(withDepartments = true): TerrainManifest {
  const heights = {
    file: "heights.bin",
    bytes: CELLS * 2,
    sha256: "a".repeat(64),
    grid: SPEC,
    encoding: {
      format: "int16",
      endianness: "little",
      units: "meters",
      layout: "row-major",
    },
    elevation: {
      minMeters: 0,
      maxMeters: 100,
      meanMeters: 50,
      p001Meters: 0,
      p999Meters: 100,
    },
  } as const;
  const satellite = {
    file: "sat.jpg",
    bytes: 10,
    sha256: "b".repeat(64),
    grid: SPEC,
  } as const;
  const departments = withDepartments
    ? {
        index: {
          file: "departments.bin",
          bytes: CELLS,
          sha256: "c".repeat(64),
          grid: SPEC,
          encoding: {
            format: "uint8",
            layout: "row-major",
            semantics: "department-index",
          },
        } as const,
        sdf: {
          file: "sdf.bin",
          bytes: CELLS,
          sha256: "d".repeat(64),
          encoding: {
            format: "int8",
            layout: "row-major",
            units: "cells",
            clamp: 127,
          },
        } as const,
        provinceBBoxGrid: [1, 0, 3, 1] as const,
      }
    : undefined;
  const level = { heights, satellite, departments };
  return {
    schemaVersion: 1,
    pipelineVersion: 3,
    levels: { default: level, high: level },
    boundaries: withDepartments
      ? {
          file: {
            file: "departments.json",
            bytes: 200,
            sha256: "e".repeat(64),
          },
          provinceBBoxLonLat: [-67, -25, -64, -21] as const,
        }
      : undefined,
    sources: {
      dem: { file: "d", path: "data/raw/d", bytes: 1, sha256: "f".repeat(64) },
      satellite: {
        file: "s",
        path: "data/raw/s",
        bytes: 1,
        sha256: "1".repeat(64),
      },
      attribution: "test",
    },
  };
}

function departmentsDoc(): object {
  return {
    schemaVersion: 2,
    departments: Array.from({ length: DEPARTMENT_COUNT }, (_, k) => ({
      index: k + 1,
      // Names come verbatim from the source's shapeName, accents
      // included (e.g. "Yaví").
      name: k === DEPARTMENT_COUNT - 1 ? "Yaví" : `Depto ${k + 1}`,
    })),
    attribution: "Boundaries: geoBoundaries gbOpen, CC BY 3.0 IGO.",
  };
}

function ok(body: Uint8Array | object): FetchResponseLike {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    arrayBuffer: () => {
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(0);
      const copy = new Uint8Array(bytes);
      return Promise.resolve(copy.buffer);
    },
  };
}

function httpError(status: number): FetchResponseLike {
  return {
    ok: false,
    status,
    json: () => Promise.reject(new Error("no body")),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  };
}

function fetchFrom(
  files: Record<string, Uint8Array | object | undefined>,
): FetchLike {
  return (url) => {
    const body = files[url];
    if (body === undefined) return Promise.resolve(httpError(404));
    return Promise.resolve(ok(body));
  };
}

function goodFiles(): Record<string, Uint8Array | object> {
  return {
    "departments.bin": new Uint8Array([0, 1, 2, 3, 4, 5, 16, 0]),
    "sdf.bin": new Uint8Array([255, 254, 0, 1, 2, 127, 128, 255]),
    "departments.json": departmentsDoc(),
  };
}

describe("loadDepartments", () => {
  it("fetches and decodes index, sdf and metadata", async () => {
    const data = await loadDepartments(
      stubManifest(),
      "default",
      fetchFrom(goodFiles()),
    );
    expect(data.grid).toBe(SPEC);
    expect([...data.index]).toEqual([0, 1, 2, 3, 4, 5, 16, 0]);
    // SDF bytes are Int8: 255 -> -1, 254 -> -2, 128 -> -128.
    expect([...data.sdf]).toEqual([-1, -2, 0, 1, 2, 127, -128, -1]);
    expect(data.departments).toHaveLength(DEPARTMENT_COUNT);
    expect(data.departments[0]?.index).toBe(1);
    expect(data.departments[0]?.name).toBe("Depto 1");
    // The name is the source's shapeName verbatim, accents included.
    expect(data.departments[15]?.name).toBe("Yaví");
    expect(data.provinceBBoxGrid).toEqual([1, 0, 3, 1]);
    expect(data.provinceBBoxLonLat).toEqual([-67, -25, -64, -21]);
    expect(data.attribution).toMatch(/CC BY 3\.0 IGO/);
  });

  it("prefixes file names with baseUrl", async () => {
    const seen: string[] = [];
    const fetchFn: FetchLike = (url) => {
      seen.push(url);
      const body = goodFiles()[url.slice("data/".length)];
      return Promise.resolve(body === undefined ? httpError(404) : ok(body));
    };
    await loadDepartments(stubManifest(), "high", fetchFn, "data/");
    expect(seen).toEqual([
      "data/departments.bin",
      "data/sdf.bin",
      "data/departments.json",
    ]);
  });

  it("throws DepartmentsDataError when the manifest predates pipeline v3", async () => {
    await expect(
      loadDepartments(stubManifest(false), "default", fetchFrom(goodFiles())),
    ).rejects.toBeInstanceOf(DepartmentsDataError);
  });

  it("throws TerrainHttpError on an HTTP error", async () => {
    const files = goodFiles();
    delete files["departments.bin"];
    await expect(
      loadDepartments(stubManifest(), "default", fetchFrom(files)),
    ).rejects.toBeInstanceOf(TerrainHttpError);
    delete files["departments.json"];
    await expect(
      loadDepartments(
        stubManifest(),
        "default",
        fetchFrom({ ...goodFiles(), "departments.json": undefined }),
      ),
    ).rejects.toBeInstanceOf(TerrainHttpError);
  });

  it("rejects a payload whose size contradicts the manifest", async () => {
    const files = {
      ...goodFiles(),
      "departments.bin": new Uint8Array(CELLS - 1),
    };
    await expect(
      loadDepartments(stubManifest(), "default", fetchFrom(files)),
    ).rejects.toBeInstanceOf(DepartmentsDataError);
  });

  it("rejects a departments.json with the wrong shape", async () => {
    await expect(
      loadDepartments(
        stubManifest(),
        "default",
        fetchFrom({ ...goodFiles(), "departments.json": { schemaVersion: 99 } }),
      ),
    ).rejects.toBeInstanceOf(DepartmentsDataError);
  });

  it("rejects duplicate or out-of-range department indices", async () => {
    const dup = departmentsDoc() as { departments: { index: number }[] };
    dup.departments[0]!.index = 2;
    await expect(
      loadDepartments(
        stubManifest(),
        "default",
        fetchFrom({ ...goodFiles(), "departments.json": dup }),
      ),
    ).rejects.toBeInstanceOf(DepartmentsDataError);
  });
});
