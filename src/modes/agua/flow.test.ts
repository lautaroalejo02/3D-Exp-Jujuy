import { describe, expect, it } from "vitest";

import {
  ACC_LOG2_SCALE,
  BASIN_OTHER,
  BASIN_OUTSIDE,
  buildSpawnCells,
  D8_DI,
  D8_DJ,
  encodeAccLog2,
  findDepressions,
  FLOW_DIR_NONE,
  flowAccumulation,
  flowDirectionsD8,
  flowTarget,
  labelBasins,
  priorityFloodFill,
  riverThreshold,
  routeElevations,
} from "./flow";

/** Row-major Float32Array from a 2D literal. */
function grid(rows: readonly (readonly number[])[]): {
  data: Float32Array;
  width: number;
  height: number;
} {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const data = new Float32Array(width * height);
  rows.forEach((row, j) => {
    expect(row.length).toBe(width);
    row.forEach((v, i) => {
      data[j * width + i] = v;
    });
  });
  return { data, width, height };
}

function insideMask(
  width: number,
  height: number,
  cells: readonly (readonly [number, number])[],
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const [i, j] of cells) mask[j * width + i] = 1;
  return mask;
}

describe("priorityFloodFill", () => {
  it("keeps every border cell at its own elevation", () => {
    const { data, width, height } = grid([
      [5, 4, 3],
      [6, 1, 2],
      [7, 8, 9],
    ]);
    const { filled } = priorityFloodFill(data, width, height);
    for (const [i, j] of [
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 1],
      [2, 1],
      [0, 2],
      [1, 2],
      [2, 2],
    ] as const) {
      expect(filled[j * width + i]).toBe(data[j * width + i]);
    }
  });

  it("fills a pit to its spill level plus epsilon", () => {
    // 5x5 rim at 10, center pit at 0.
    const { data, width, height } = grid([
      [10, 10, 10, 10, 10],
      [10, 10, 10, 10, 10],
      [10, 10, 0, 10, 10],
      [10, 10, 10, 10, 10],
      [10, 10, 10, 10, 10],
    ]);
    const { filled } = priorityFloodFill(data, width, height);
    const center = filled[2 * width + 2] ?? 0;
    expect(center).toBeGreaterThan(10);
    expect(center).toBeLessThan(10.1);
  });

  it("keeps a strict downslope across flats", () => {
    const { data, width, height } = grid([
      [5, 5, 5, 5, 5],
      [5, 5, 5, 5, 5],
      [5, 5, 5, 5, 5],
      [5, 5, 5, 5, 5],
      [5, 5, 5, 5, 5],
    ]);
    const { filled } = priorityFloodFill(data, width, height);
    // Every non-border cell must have a strictly lower filled neighbor —
    // that is exactly what D8 needs to find a drain on the flat.
    for (let j = 1; j < height - 1; j++) {
      for (let i = 1; i < width - 1; i++) {
        const z = filled[j * width + i] ?? 0;
        let hasLower = false;
        for (let d = 1; d <= 8; d++) {
          const ni = i + (D8_DI[d] ?? 0);
          const nj = j + (D8_DJ[d] ?? 0);
          if ((filled[nj * width + ni] ?? Infinity) < z) hasLower = true;
        }
        expect(hasLower, `cell ${i},${j}`).toBe(true);
      }
    }
  });

  it("does not raise cells on a strictly sloped grid", () => {
    const { data, width, height } = grid([
      [0, 1, 2, 3],
      [0, 1, 2, 3],
      [0, 1, 2, 3],
    ]);
    const { filled } = priorityFloodFill(data, width, height);
    expect([...filled]).toEqual([...data]);
  });

  it("pops cells in nondecreasing filled order covering every cell", () => {
    const { data, width, height } = grid([
      [9, 8, 7, 6],
      [9, 3, 2, 6],
      [9, 8, 7, 6],
    ]);
    const { filled, order } = priorityFloodFill(data, width, height);
    expect(order.length).toBe(width * height);
    const seen = new Set(order);
    expect(seen.size).toBe(width * height);
    let prev = -Infinity;
    for (const c of order) {
      const z = filled[c] ?? 0;
      expect(z).toBeGreaterThanOrEqual(prev);
      prev = z;
    }
  });
});

describe("flowDirectionsD8", () => {
  it("points downhill on a ramp", () => {
    // Heights increase eastward -> every interior cell drains west-ish:
    // W/NW/SW all tie on a planar slope; the fixed direction order picks
    // the first lowest, which is SW here (checked before W and NW).
    const { data, width, height } = grid([
      [0, 1, 2, 3, 4],
      [0, 1, 2, 3, 4],
      [0, 1, 2, 3, 4],
    ]);
    const dir = flowDirectionsD8(data, width, height);
    for (let j = 0; j < height; j++) {
      for (let i = 1; i < width; i++) {
        const t = flowTarget(dir, j * width + i, width, height);
        expect(t).toBeGreaterThanOrEqual(0);
        expect(data[t] ?? 0).toBeLessThan(data[j * width + i] ?? 0);
      }
      // West column: no lower neighbor in-bounds.
      expect(dir[j * width]).toBe(FLOW_DIR_NONE);
    }
  });

  it("gives pits a way out after filling", () => {
    const { data, width, height } = grid([
      [10, 10, 10, 10, 10],
      [10, 10, 10, 10, 10],
      [10, 10, 0, 10, 10],
      [10, 10, 10, 10, 10],
      [10, 10, 10, 10, 10],
    ]);
    const { filled } = priorityFloodFill(data, width, height);
    const dir = flowDirectionsD8(filled, width, height);
    expect(dir[2 * width + 2]).not.toBe(FLOW_DIR_NONE);
    // Following directions from the pit must reach a FLOW_DIR_NONE sink.
    let c = 2 * width + 2;
    for (let steps = 0; steps < width * height; steps++) {
      const t = flowTarget(dir, c, width, height);
      if (t < 0) return;
      c = t;
    }
    throw new Error("flow chain never terminated");
  });
});

describe("flowAccumulation", () => {
  it("counts upstream cells on a ramp", () => {
    const { data, width, height } = grid([
      [4, 3, 2, 1, 0],
      [4, 3, 2, 1, 0],
      [4, 3, 2, 1, 0],
    ]);
    const { filled } = priorityFloodFill(data, width, height);
    const dir = flowDirectionsD8(filled, width, height);
    const acc = flowAccumulation(dir, filled, width, height);
    // Heights decrease eastward -> flow goes east; cell i collects i+1.
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        expect(acc[j * width + i]).toBe(i + 1);
      }
    }
  });

  it("converges a valley into the outlet", () => {
    // Bowl: every cell drains to the bottom-center cell (1,1) is lowest
    // in-bounds... make (1,1) the minimum; the edge drains around it.
    const { data, width, height } = grid([
      [9, 9, 9],
      [9, 0, 9],
      [8, 8, 8],
    ]);
    const { filled } = priorityFloodFill(data, width, height);
    const dir = flowDirectionsD8(filled, width, height);
    const acc = flowAccumulation(dir, filled, width, height);
    // The pit collects itself + the whole 9-rim (5 cells drain into it).
    expect(acc[width + 1]).toBeGreaterThanOrEqual(4);
    // Conservation: accumulation summed over the sink cells (dir NONE)
    // equals the cell count — every drop lands somewhere.
    let sinks = 0;
    for (let k = 0; k < acc.length; k++) {
      if (dir[k] === FLOW_DIR_NONE) sinks += acc[k] ?? 0;
    }
    expect(sinks).toBe(width * height);
  });
});

describe("labelBasins", () => {
  it("labels one basin for a uniform outflow", () => {
    // Row heights decrease eastward: all inside cells drain east to the
    // last inside column -> a single basin.
    const width = 8;
    const height = 4;
    const data = new Float32Array(width * height);
    for (let k = 0; k < data.length; k++) {
      data[k] = 8 - (k % width);
    }
    const { filled } = priorityFloodFill(data, width, height);
    const dir = flowDirectionsD8(filled, width, height);
    const acc = flowAccumulation(dir, filled, width, height);
    const inside = insideMask(width, height, [
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
      [5, 1],
      [6, 1],
    ]);
    const { labels, basins } = labelBasins(dir, inside, acc, width, height);
    // One row of inside cells draining east shares the single last
    // inside cell (6,1) as its pour point -> exactly one basin.
    expect(basins.length).toBe(1);
    expect(basins[0]?.cells).toBe(6);
    expect(basins[0]?.outlet).toEqual([6, 1]);
    // The terminal sits at the grid edge, outside the mask -> abierta.
    expect(basins[0]?.kind).toBe("abierta");
    expect(labels[width]).toBe(BASIN_OUTSIDE);
    expect(labels[0]).toBe(BASIN_OUTSIDE);
    for (let i = 1; i <= 6; i++) {
      expect(labels[width + i]).toBe(1);
    }
    expect(labels[2 * width + 3]).toBe(BASIN_OUTSIDE);
  });

  it("keeps the largest basin and sorts the rest to otras", () => {
    // Same eastward-draining rows; two separate inside strips pour out
    // at different cells, so the larger strip wins the single kept slot.
    const width = 8;
    const height = 4;
    const data = new Float32Array(width * height);
    for (let k = 0; k < data.length; k++) {
      data[k] = 8 - (k % width);
    }
    const { filled } = priorityFloodFill(data, width, height);
    const dir = flowDirectionsD8(filled, width, height);
    const acc = flowAccumulation(dir, filled, width, height);
    const inside = insideMask(width, height, [
      // Basin A: cols 1..6 of row 1, outlet (6,1), acc 7 (includes the
      // outside col-0 cell draining in — upstream counts everything).
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
      [5, 1],
      [6, 1],
      // Basin B: cols 1..3 of row 2, outlet (3,2), acc 3.
      [1, 2],
      [2, 2],
      [3, 2],
    ]);
    const { labels, basins } = labelBasins(
      dir,
      inside,
      acc,
      width,
      height,
      1,
    );
    expect(basins.length).toBe(1);
    expect(basins[0]?.cells).toBe(6);
    expect(basins[0]?.outlet).toEqual([6, 1]);
    expect(basins[0]?.outletAcc).toBe(7);
    for (let i = 1; i <= 6; i++) {
      expect(labels[width + i]).toBe(1);
    }
    for (let i = 1; i <= 3; i++) {
      expect(labels[2 * width + i]).toBe(BASIN_OTHER);
    }
    expect(labels[0]).toBe(BASIN_OUTSIDE);
    expect(labels[3 * width + 7]).toBe(BASIN_OUTSIDE);
  });
});

describe("findDepressions + routeElevations (selective fill)", () => {
  /**
   * 13x13 grid: an outer ramp draining south plus a 5x5 bowl (walls 20,
   * floor ~5, bottom 0 at the center) — a depression of 25 ponded cells
   * and 15 m of depth.
   */
  function bowlGrid(): {
    data: Float32Array;
    width: number;
    height: number;
  } {
    const width = 13;
    const height = 13;
    const data = new Float32Array(width * height);
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        data[j * width + i] = 30 - j; // southward ramp, drains off edge
      }
    }
    // Bowl walls ring cells 3..7 in both axes.
    for (let j = 3; j <= 7; j++) {
      for (let i = 3; i <= 7; i++) {
        data[j * width + i] = 50;
      }
    }
    for (let j = 4; j <= 6; j++) {
      for (let i = 4; i <= 6; i++) {
        data[j * width + i] = 20;
      }
    }
    data[6 * width + 6] = 0; // pit bottom
    return { data, width, height };
  }

  it("a big deep depression stays closed: its bottom is a terminal sink", () => {
    const { data, width, height } = bowlGrid();
    const { filled } = priorityFloodFill(data, width, height);
    const { filled: filledMin } = priorityFloodFill(data, width, height, 0);
    const depressions = findDepressions(data, filledMin, width, height);
    expect(depressions.list.length).toBe(1);
    // Only the 3x3 floor ponds — the 50-ring is the rim, not depression.
    expect(depressions.list[0]?.cells).toBe(9);
    expect(depressions.list[0]?.depthMeters).toBeGreaterThan(10);

    // Thresholds below the bowl's size/depth -> retained.
    const z = routeElevations(data, filled, filledMin, depressions, width, height, 4, 1);
    const dir = flowDirectionsD8(z, width, height);
    const acc = flowAccumulation(dir, z, width, height);
    const bottom = 6 * width + 6;
    expect(dir[bottom]).toBe(FLOW_DIR_NONE);
    // The whole bowl (floor + the inward-draining rim) collects into the
    // bottom; nothing crosses the rim.
    expect(acc[bottom]).toBeGreaterThanOrEqual(25);

    // Basins: inside cells of the bowl label "cerrada".
    const inside = insideMask(width, height, [
      [4, 4],
      [5, 5],
      [6, 6],
      [7, 4],
    ]);
    const { labels, basins } = labelBasins(dir, inside, acc, width, height);
    expect(basins.length).toBe(1);
    expect(basins[0]?.kind).toBe("cerrada");
    expect(basins[0]?.terminal).toEqual([6, 6]);
    for (const [i, j] of [
      [4, 4],
      [5, 5],
      [6, 6],
      [7, 4],
    ] as const) {
      expect(labels[j * width + i]).toBe(1);
    }
  });

  it("a 1-cell pit is filled and drains out like noise", () => {
    // Ramp to the south with a single 1-cell hole of depth 10.
    const width = 7;
    const height = 7;
    const data = new Float32Array(width * height);
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        data[j * width + i] = 20 - j;
      }
    }
    data[3 * width + 3] = 5;
    const { filled } = priorityFloodFill(data, width, height);
    const { filled: filledMin } = priorityFloodFill(data, width, height, 0);
    const depressions = findDepressions(data, filledMin, width, height);
    expect(depressions.list.length).toBe(1);
    expect(depressions.list[0]?.cells).toBe(1);

    // Any area threshold above 1 fills it -> it drains off the edge.
    const z = routeElevations(data, filled, filledMin, depressions, width, height, 4, 1);
    const dir = flowDirectionsD8(z, width, height);
    expect(dir[3 * width + 3]).not.toBe(FLOW_DIR_NONE);
    let c = 3 * width + 3;
    for (let steps = 0; steps < width * height; steps++) {
      const t = flowTarget(dir, c, width, height);
      if (t < 0) {
        // The chain ended at an EDGE cell, not at the pit.
        const ci = c % width;
        const cj = (c / width) | 0;
        expect(c).not.toBe(3 * width + 3);
        expect(
          ci === 0 || ci === width - 1 || cj === 0 || cj === height - 1,
        ).toBe(true);
        return;
      }
      c = t;
    }
    throw new Error("filled pit never reached an edge sink");
  });

  it("nested pits inside one retained depression merge into one basin", () => {
    // Same bowl plus a second pit bottom at (4,4): two interior sinks
    // that share the one ponded component. Basin labeling must not
    // split them — a micro-pit on a salar floor is part of the same
    // closed basin.
    const { data, width, height } = bowlGrid();
    data[4 * width + 4] = 1;
    const { filled } = priorityFloodFill(data, width, height);
    const { filled: filledMin } = priorityFloodFill(data, width, height, 0);
    const depressions = findDepressions(data, filledMin, width, height);
    const z = routeElevations(data, filled, filledMin, depressions, width, height, 4, 1);
    const dir = flowDirectionsD8(z, width, height);
    const acc = flowAccumulation(dir, z, width, height);
    expect(dir[6 * width + 6]).toBe(FLOW_DIR_NONE);
    expect(dir[4 * width + 4]).toBe(FLOW_DIR_NONE);

    const inside = insideMask(width, height, [
      [4, 4],
      [5, 4],
      [6, 4],
      [4, 5],
      [5, 5],
      [6, 5],
      [4, 6],
      [5, 6],
      [6, 6],
    ]);
    const { labels, basins } = labelBasins(
      dir,
      inside,
      acc,
      width,
      height,
      8,
      depressions,
      4,
      1,
    );
    expect(basins.length).toBe(1);
    expect(basins[0]?.kind).toBe("cerrada");
    // The basin's terminal is the component's deepest pit bottom.
    expect(basins[0]?.terminal).toEqual([6, 6]);
    expect(basins[0]?.cells).toBe(9);
    for (let k = 0; k < inside.length; k++) {
      if (inside[k]) expect(labels[k]).toBe(1);
    }
  });

  it("a wide but shallow pond also counts as noise and fills", () => {
    // 5x5 flat-bottomed pond only 0.5 m below its rim: area big, depth tiny.
    const width = 9;
    const height = 9;
    const data = new Float32Array(width * height).fill(20);
    for (let j = 2; j <= 6; j++) {
      for (let i = 2; i <= 6; i++) {
        data[j * width + i] = 19.5;
      }
    }
    const { filled } = priorityFloodFill(data, width, height);
    const { filled: filledMin } = priorityFloodFill(data, width, height, 0);
    const depressions = findDepressions(data, filledMin, width, height);
    expect(depressions.list.length).toBe(1);
    expect(depressions.list[0]?.cells).toBe(25);
    expect(depressions.list[0]?.depthMeters).toBeLessThan(1);
    const z = routeElevations(data, filled, filledMin, depressions, width, height, 4, 1);
    const dir = flowDirectionsD8(z, width, height);
    // No interior sink: every ponded cell drains out.
    for (let j = 2; j <= 6; j++) {
      for (let i = 2; i <= 6; i++) {
        expect(dir[j * width + i]).not.toBe(FLOW_DIR_NONE);
      }
    }
  });
});

describe("encodeAccLog2", () => {
  it("encodes log2 upstream counts", () => {
    const enc = encodeAccLog2(new Float32Array([1, 2, 4, 8, 1024]));
    expect([...enc]).toEqual([
      0,
      ACC_LOG2_SCALE,
      2 * ACC_LOG2_SCALE,
      3 * ACC_LOG2_SCALE,
      10 * ACC_LOG2_SCALE,
    ]);
  });
});

describe("buildSpawnCells", () => {
  it("lists the inside cells row-major", () => {
    const mask = insideMask(4, 3, [
      [0, 0],
      [2, 1],
      [3, 2],
    ]);
    const cells = buildSpawnCells(mask, 4, 3);
    expect([...cells]).toEqual([0, 6, 11]);
  });
});

describe("riverThreshold", () => {
  it("picks the value at the requested rank", () => {
    const acc = new Float32Array([10, 8, 6, 4, 2]);
    const inside = new Uint8Array([1, 1, 1, 1, 1]);
    // 5 cells; fraction .4 -> rank ceil(2)-1 = 1 -> 8.
    expect(riverThreshold(acc, inside, 0.4)).toBe(8);
    expect(riverThreshold(acc, inside, 1)).toBe(2);
  });
});
