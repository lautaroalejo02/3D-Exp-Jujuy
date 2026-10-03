import { describe, expect, it } from "vitest";

import type { GridSpec } from "../geo/grid";
import { gridToWorld } from "../geo/world";
import { intersectHeightfield } from "../picking/ray";
import { Heightfield } from "../terrain/heightfield";
import {
  formatElevation,
  formatLatitude,
  formatLongitude,
  OUTSIDE_JUJUY,
  precisionNote,
  regionLabel,
  UNASSIGNED_REGION,
} from "./pick-panel";

describe("pick panel formatters", () => {
  it("formats latitude with 4 decimals, comma and hemisphere", () => {
    expect(formatLatitude(-23.20544)).toBe("23,2054° S");
    expect(formatLatitude(34.5)).toBe("34,5000° N");
    expect(formatLatitude(0)).toBe("0,0000° N");
  });

  it("formats longitude with 4 decimals, comma and hemisphere", () => {
    expect(formatLongitude(-65.35048)).toBe("65,3505° O");
    expect(formatLongitude(2.3522)).toBe("2,3522° E");
  });

  it("formats elevation rounded with the Spanish thousands separator", () => {
    expect(formatElevation(2939)).toBe("2.939 m s. n. m.");
    expect(formatElevation(2939.4)).toBe("2.939 m s. n. m.");
    expect(formatElevation(350)).toBe("350 m s. n. m.");
    expect(formatElevation(-5)).toBe("-5 m s. n. m.");
  });

  it("builds the precision note from data", () => {
    expect(precisionNote({ cellSizeMeters: 305.4 })).toBe(
      "Dato del modelo de elevación (celdas de ~305 m)",
    );
    expect(
      precisionNote({ cellSizeMeters: 305.4, meanAbsErrorMeters: 7.453 }),
    ).toBe("Dato del modelo de elevación (celdas de ~305 m · ±~7 m en promedio)");
  });
});

describe("pick panel region label", () => {
  // Element 0 is the outside-Jujuy slot; elements 1.. map departments.
  const names: (string | undefined)[] = [undefined, "Puna", "Quebrada"];

  it("shows 'Fuera de Jujuy' only when the raster reads 0", () => {
    expect(regionLabel(names, 0)).toBe(OUTSIDE_JUJUY);
  });

  it("shows the region name of a mapped department", () => {
    expect(regionLabel(names, 1)).toBe("Puna");
    expect(regionLabel(names, 2)).toBe("Quebrada");
  });

  it("never says 'Fuera de Jujuy' for an in-province cell without a region", () => {
    expect(regionLabel(names, 3)).toBe(UNASSIGNED_REGION);
    expect(regionLabel(names, 99)).toBe(UNASSIGNED_REGION);
  });
});

describe("pick elevation coherence with the DEM", () => {
  it("the elevation the panel shows equals heightAtLonLat at the hit", () => {
    const spec: GridSpec = {
      zoom: 10,
      originPx: [82048, 147200],
      width: 128,
      height: 128,
      scale: 1,
    };
    const heights = new Float32Array(spec.width * spec.height);
    for (let j = 0; j < spec.height; j++) {
      for (let i = 0; i < spec.width; i++) {
        heights[j * spec.width + i] = 700 + 30 * i + 15 * j;
      }
    }
    const field = new Heightfield(heights, spec);
    const [x, , z] = gridToWorld(spec, 40, 60);
    const hit = intersectHeightfield(
      { origin: [x, 20, z], direction: [0, -1, 0] },
      field,
      2.5,
    );
    expect(hit).toBeDefined();
    // The panel renders formatElevation(hit.elevationMeters); this asserts
    // the value behind it is exactly what the DEM reports at that lon/lat.
    const dem = field.heightAtLonLat(hit!.lonLat[0], hit!.lonLat[1]);
    expect(dem).toBeDefined();
    expect(hit!.elevationMeters).toBeCloseTo(dem!, 6);
    expect(formatElevation(hit!.elevationMeters)).toBe(
      formatElevation(dem!),
    );
  });
});
