import { describe, expect, it } from "vitest";

import {
  assertPlacesDoc,
  assertRawPlacesDoc,
  buildPlaceEntry,
  eswikiArticleUrl,
  loadPlaces,
  placeDescription,
  placeDisplayName,
  PLACES_SCHEMA_VERSION,
  type RawWikidataPlace,
} from "./places-manifest";
import { TerrainHttpError } from "./heightfield";
import type { FetchLike } from "./heightfield";

function stubRaw(over: Partial<RawWikidataPlace> = {}): RawWikidataPlace {
  return {
    id: "Q1",
    lastrevid: 123,
    url: "https://www.wikidata.org/wiki/Q1",
    label: { es: "Nombre", en: "Name" },
    description: { es: "descripción", en: "description" },
    coordinates: { lat: -23.5, lon: -65.5, precision: 0.001 },
    eswiki: "Nombre",
    ...over,
  };
}

describe("placeDisplayName", () => {
  it("prefers the Spanish label", () => {
    expect(placeDisplayName(stubRaw())).toBe("Nombre");
  });

  it("falls back to the English label", () => {
    expect(placeDisplayName(stubRaw({ label: { es: null, en: "Name" } }))).toBe(
      "Name",
    );
  });

  it("throws when no label exists", () => {
    expect(() =>
      placeDisplayName(stubRaw({ label: { es: null, en: null } })),
    ).toThrow(/Q1/);
  });
});

describe("placeDescription", () => {
  it("returns the Spanish description", () => {
    expect(placeDescription(stubRaw())).toBe("descripción");
  });

  it("is null without a Spanish description (no English fallback)", () => {
    expect(
      placeDescription(stubRaw({ description: { es: null, en: "desc" } })),
    ).toBeNull();
  });
});

describe("eswikiArticleUrl", () => {
  it("keeps a simple title verbatim", () => {
    expect(eswikiArticleUrl("Purmamarca")).toBe(
      "https://es.wikipedia.org/wiki/Purmamarca",
    );
  });

  it("converts spaces to underscores and percent-encodes non-ASCII", () => {
    expect(eswikiArticleUrl("Serranía de Hornocal")).toBe(
      "https://es.wikipedia.org/wiki/Serran%C3%ADa_de_Hornocal",
    );
    expect(eswikiArticleUrl("Salinas Grandes (Jujuy y Salta)")).toBe(
      "https://es.wikipedia.org/wiki/Salinas_Grandes_(Jujuy_y_Salta)",
    );
  });
});

describe("buildPlaceEntry", () => {
  const base = {
    demElevationMeters: 2329.6,
    department: "Tumbaya",
  };

  it("uses the DEM elevation rounded to the meter", () => {
    const place = buildPlaceEntry(stubRaw(), base);
    expect(place.elevationMeters).toBe(2330);
    expect(place.elevationSource).toBe("dem");
    expect(place.demElevationMeters).toBe(2330);
    expect(place.detailElevationMeters).toBeUndefined();
  });

  it("prefers the detail DEM when the point falls inside a patch", () => {
    const place = buildPlaceEntry(stubRaw(), {
      ...base,
      detailElevationMeters: 2400.4,
    });
    expect(place.elevationMeters).toBe(2400);
    expect(place.elevationSource).toBe("detail-dem");
    expect(place.demElevationMeters).toBe(2330);
    expect(place.detailElevationMeters).toBe(2400);
  });

  it("marks places outside the province raster", () => {
    const place = buildPlaceEntry(stubRaw(), {
      demElevationMeters: 4000,
      department: undefined,
    });
    expect(place.department).toBe("Fuera de Jujuy");
  });

  it("carries name, description, coords and links", () => {
    const place = buildPlaceEntry(stubRaw(), base);
    expect(place.id).toBe("Q1");
    expect(place.name).toBe("Nombre");
    expect(place.description).toBe("descripción");
    expect(place.lat).toBe(-23.5);
    expect(place.lon).toBe(-65.5);
    expect(place.wikidataUrl).toBe("https://www.wikidata.org/wiki/Q1");
    expect(place.eswikiUrl).toBe("https://es.wikipedia.org/wiki/Nombre");
  });

  it("emits a null eswikiUrl when there is no eswiki article", () => {
    const place = buildPlaceEntry(stubRaw({ eswiki: null }), base);
    expect(place.eswikiUrl).toBeNull();
  });

  it("emits a null description when the source lacks a Spanish one", () => {
    const place = buildPlaceEntry(
      stubRaw({ description: { es: null, en: "d" } }),
      base,
    );
    expect(place.description).toBeNull();
  });
});

describe("assertRawPlacesDoc", () => {
  it("accepts the committed document shape", () => {
    expect(() =>
      assertRawPlacesDoc({ places: [stubRaw()] }),
    ).not.toThrow();
  });

  it("rejects a document without places", () => {
    expect(() => assertRawPlacesDoc({})).toThrow();
    expect(() => assertRawPlacesDoc(null)).toThrow();
    expect(() => assertRawPlacesDoc({ places: "x" })).toThrow();
  });

  it("rejects a place with a non-Q-id", () => {
    expect(() =>
      assertRawPlacesDoc({ places: [stubRaw({ id: "not-a-qid" })] }),
    ).toThrow(/not-a-qid/);
  });

  it("rejects a place with a non-Wikidata field", () => {
    expect(() =>
      assertRawPlacesDoc({ places: [{ ...stubRaw(), category: "Puna" }] }),
    ).toThrow(/non-Wikidata field.*category/);
    expect(() =>
      assertRawPlacesDoc({
        places: [{ ...stubRaw(), label: { es: "x", en: "x", fr: "x" } }],
      }),
    ).toThrow(/non-Wikidata field.*label\.fr/);
  });
});

describe("loadPlaces", () => {
  const entry = buildPlaceEntry(stubRaw(), {
    demElevationMeters: 2330,
    department: "Tumbaya",
  });
  const doc = {
    schemaVersion: PLACES_SCHEMA_VERSION,
    pipelineVersion: 1,
    inputSha256: "0".repeat(64),
    sources: {},
    places: [entry],
  };

  const stubFetch = (body: unknown, ok = true, status = 200): FetchLike => {
    return () =>
      Promise.resolve({
        ok,
        status,
        json: () => Promise.resolve(body),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      });
  };

  it("loads and validates places.json", async () => {
    const loaded = await loadPlaces(stubFetch(doc));
    expect(loaded.places).toHaveLength(1);
    expect(loaded.places[0]?.id).toBe("Q1");
  });

  it("throws TerrainHttpError on HTTP errors", async () => {
    await expect(
      loadPlaces(stubFetch(undefined, false, 404)),
    ).rejects.toBeInstanceOf(TerrainHttpError);
  });

  it("rejects a doc with the wrong schema version", async () => {
    await expect(
      loadPlaces(stubFetch({ ...doc, schemaVersion: 999 })),
    ).rejects.toThrow(/schema version/);
  });

  it("rejects a place entry missing required fields", async () => {
    const broken = {
      ...doc,
      places: [{ ...entry, elevationMeters: "high" }],
    };
    await expect(loadPlaces(stubFetch(broken))).rejects.toThrow();
  });
});

describe("withheld descriptions", () => {
  it("drops a Wikidata description contradicted by a primary source", () => {
    expect(
      placeDescription({
        id: "Q2893104",
        description: { es: "el salar más grande de la Argentina", en: null },
      } as unknown as Parameters<typeof placeDescription>[0]),
    ).toBeNull();
  });
});
