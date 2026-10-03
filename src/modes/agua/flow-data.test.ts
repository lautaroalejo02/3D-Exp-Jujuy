import { describe, expect, it } from "vitest";

import type { GridSpec } from "../../geo/grid";
import {
  TerrainHttpError,
  type FetchLike,
  type FetchResponseLike,
} from "../../terrain/heightfield";
import { ACC_LOG2_SCALE } from "./flow";
import {
  decodeAcc,
  FlowDataError,
  loadFlowData,
} from "./flow-data";

/** 8-cell spec: 4x2 grid. */
const SPEC: GridSpec = {
  zoom: 10,
  originPx: [82048, 147200],
  width: 4,
  height: 2,
  scale: 1,
};

const CELLS = SPEC.width * SPEC.height;

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

function flowJson(): object {
  return {
    schemaVersion: 2,
    pipelineVersion: 2,
    grid: SPEC,
    files: {
      "flow-dir.bin": { file: "flow-dir.bin", bytes: CELLS, sha256: "a" },
      "flow-acc.bin": {
        file: "flow-acc.bin",
        bytes: CELLS * 2,
        sha256: "b",
      },
      "flow-basins.bin": {
        file: "flow-basins.bin",
        bytes: CELLS,
        sha256: "c",
      },
    },
    basins: [
      {
        id: 1,
        kind: "cerrada",
        cells: 5,
        outletAcc: 9,
        outlet: [2, 1],
        outletLonLat: [-65, -23],
        outletDepartmentIndex: 7,
        terminal: [1, 1],
        terminalLonLat: [-65.2, -23.1],
        sinkName: "Laguna de Guayatayoc",
      },
    ],
    riverAcc: 4,
    sources: { attribution: "DEM Terrarium + geoBoundaries" },
  };
}

function goodFiles(): Record<string, Uint8Array | object> {
  const acc = new Uint16Array(CELLS);
  acc[3] = 2 * ACC_LOG2_SCALE; // log2(4) -> acc 4
  return {
    "flow.json": flowJson(),
    "flow-dir.bin": new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    "flow-acc.bin": new Uint8Array(acc.buffer),
    "flow-basins.bin": new Uint8Array([0, 1, 1, 0, 255, 255, 1, 0]),
  };
}

describe("loadFlowData", () => {
  it("fetches and decodes dir, acc and basin rasters", async () => {
    const data = await loadFlowData(fetchFrom(goodFiles()));
    expect(data.grid).toEqual(SPEC);
    expect([...data.dir]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...data.basins]).toEqual([0, 1, 1, 0, 255, 255, 1, 0]);
    expect(data.accLog2[3]).toBe(2 * ACC_LOG2_SCALE);
    expect(decodeAcc(data.accLog2[3] ?? 0)).toBeCloseTo(4);
    expect(data.riverAcc).toBe(4);
    expect(data.basinInfos[0]?.outletDepartmentIndex).toBe(7);
    expect(data.basinInfos[0]?.kind).toBe("cerrada");
    expect(data.basinInfos[0]?.sinkName).toBe("Laguna de Guayatayoc");
    expect(data.attribution).toMatch(/Terrarium/);
  });

  it("rejects a basin entry without a kind", async () => {
    const files = goodFiles();
    const meta = flowJson() as {
      basins: Record<string, unknown>[];
    };
    const { kind: _dropped, ...rest } = meta.basins[0] ?? {};
    meta.basins[0] = rest;
    files["flow.json"] = meta;
    await expect(loadFlowData(fetchFrom(files))).rejects.toBeInstanceOf(
      FlowDataError,
    );
  });

  it("prefixes file names with baseUrl", async () => {
    const seen: string[] = [];
    const files = goodFiles();
    const fetchFn: FetchLike = (url) => {
      seen.push(url);
      const body = files[url.slice("data/".length)];
      return Promise.resolve(body === undefined ? httpError(404) : ok(body));
    };
    await loadFlowData(fetchFn, "data/");
    expect(seen[0]).toBe("data/flow.json");
    expect(seen.slice(1).sort()).toEqual([
      "data/flow-acc.bin",
      "data/flow-basins.bin",
      "data/flow-dir.bin",
    ]);
  });

  it("throws TerrainHttpError on missing flow.json", async () => {
    await expect(loadFlowData(fetchFrom({}))).rejects.toBeInstanceOf(
      TerrainHttpError,
    );
  });

  it("throws FlowDataError on a wrong schemaVersion", async () => {
    const files = goodFiles();
    files["flow.json"] = { ...flowJson(), schemaVersion: 99 };
    await expect(loadFlowData(fetchFrom(files))).rejects.toBeInstanceOf(
      FlowDataError,
    );
  });

  it("throws FlowDataError when a raster size contradicts the manifest", async () => {
    const files = goodFiles();
    files["flow-dir.bin"] = new Uint8Array(CELLS - 1);
    await expect(loadFlowData(fetchFrom(files))).rejects.toBeInstanceOf(
      FlowDataError,
    );
  });
});
