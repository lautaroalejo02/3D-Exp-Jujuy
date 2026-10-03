import { describe, expect, it } from "vitest";

import {
  filterPlacesByName,
  normalizeSearchText,
} from "./place-search";

describe("normalizeSearchText", () => {
  it("lowercases and strips diacritics", () => {
    expect(normalizeSearchText("Yaví")).toBe("yavi");
    expect(normalizeSearchText("Quebrada de Huáhuasi")).toBe(
      "quebrada de huahuasi",
    );
    expect(normalizeSearchText("Ñandú")).toBe("nandu");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeSearchText("  Tilcara  ")).toBe("tilcara");
  });
});

describe("filterPlacesByName", () => {
  const places = [
    { name: "Purmamarca" },
    { name: "Yaví" },
    { name: "San Salvador de Jujuy" },
    { name: "Tilcara" },
  ];

  it("returns every place on an empty query", () => {
    expect(filterPlacesByName(places, "")).toHaveLength(4);
    expect(filterPlacesByName(places, "   ")).toHaveLength(4);
  });

  it("matches a case-insensitive substring", () => {
    expect(filterPlacesByName(places, "til")).toEqual([
      { name: "Tilcara" },
    ]);
    expect(filterPlacesByName(places, "SALVADOR")).toEqual([
      { name: "San Salvador de Jujuy" },
    ]);
  });

  it("matches ignoring diacritics in both directions", () => {
    expect(filterPlacesByName(places, "yavi")).toEqual([{ name: "Yaví" }]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterPlacesByName(places, "cataratas")).toEqual([]);
  });
});
