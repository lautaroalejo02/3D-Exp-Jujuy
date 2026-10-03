import { describe, expect, it } from "vitest";

import type { PlaceFacts } from "../../terrain/places-manifest";
import {
  LARGE_PLACE_VIEW_DISTANCE_KM,
  placeViewDistanceKm,
  PLACE_VIEW_DISTANCE_KM,
} from "./place-distance";

function facts(instanceOf: readonly string[]): PlaceFacts {
  return {
    instanceOf,
    population: null,
    areaKm2: null,
    heritage: [],
    foundedYear: null,
  };
}

describe("placeViewDistanceKm", () => {
  it("uses the town distance for settlements and point features", () => {
    for (const kinds of [
      ["pueblo"],
      ["localidad"],
      ["ciudad", "municipio"],
      ["asentamiento"],
      ["montaña"],
      ["colina"],
      ["fortaleza", "yacimiento arqueológico"],
    ]) {
      expect(placeViewDistanceKm({ facts: facts(kinds) }), kinds.join()).toBe(
        PLACE_VIEW_DISTANCE_KM,
      );
    }
  });

  it("uses the large-feature distance for lakes, salt flats, ranges and parks", () => {
    for (const kinds of [
      ["lago"],
      ["salar"],
      ["cordillera"],
      ["cañón", "valle"],
      ["parque nacional", "parque nacional de Argentina"],
      ["parque provincial"],
    ]) {
      expect(
        placeViewDistanceKm({ facts: facts(kinds) }),
        kinds.join(),
      ).toBe(LARGE_PLACE_VIEW_DISTANCE_KM);
    }
  });

  it("a large kind wins even when mixed with small ones", () => {
    expect(
      placeViewDistanceKm({ facts: facts(["municipio", "lago"]) }),
    ).toBe(LARGE_PLACE_VIEW_DISTANCE_KM);
  });

  it("falls back to the town distance when facts are missing", () => {
    expect(placeViewDistanceKm({ facts: null })).toBe(PLACE_VIEW_DISTANCE_KM);
    expect(
      placeViewDistanceKm({ facts: facts([]) }),
    ).toBe(PLACE_VIEW_DISTANCE_KM);
  });
});
