import { describe, expect, it } from "vitest";

import {
  assertPlacesDoc,
  assertRawCommonsPhotosDoc,
  assertRawPlacesDoc,
  assertRawWikidataFactsDoc,
  assertRawWikipediaExtractsDoc,
  buildPlaceEntry,
  buildPlaceExtract,
  buildPlaceFacts,
  buildPlacePhoto,
  commonsFullImageUrl,
  eswikiArticleUrl,
  loadPlaces,
  placeDescription,
  placeDisplayName,
  PLACES_SCHEMA_VERSION,
  stripTrackingParams,
  unattributablePhoto,
  wikidataTimeYear,
  type RawCommonsPhoto,
  type RawWikipediaExtract,
  type RawWikidataFacts,
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

// ---------------------------------------------------------------------------
// F1: photos, extracts and facts merged from the three extra raw files.
// ---------------------------------------------------------------------------

function stubPhoto(over: Partial<RawCommonsPhoto> = {}): RawCommonsPhoto {
  return {
    file: "Calle en Purmamarca.jpg",
    pageUrl: "https://commons.wikimedia.org/wiki/File:Calle_en_Purmamarca.jpg",
    thumbUrl:
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/53/" +
      "Calle_en_Purmamarca.jpg/960px-Calle_en_Purmamarca.jpg" +
      "?utm_source=commons.wikimedia.org&utm_campaign=imageinfo" +
      "&utm_content=thumbnail",
    thumbWidth: 800,
    thumbHeight: 1067,
    width: 1600,
    height: 2133,
    license: "CC BY 2.0",
    licenseUrl: "https://creativecommons.org/licenses/by/2.0",
    author: "Fotógrafo",
    credit: "https://example.test/credit",
    description: "Una calle de Purmamarca",
    isMain: true,
    ...over,
  };
}

function stubExtract(
  over: Partial<RawWikipediaExtract> = {},
): RawWikipediaExtract {
  return {
    id: "Q1",
    title: "Purmamarca",
    revision: "171623733",
    url: "https://es.wikipedia.org/wiki/Purmamarca",
    extract: "Purmamarca es una localidad del departamento de Tumbaya.",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    ...over,
  };
}

function stubFacts(over: Partial<RawWikidataFacts> = {}): RawWikidataFacts {
  return {
    id: "Q1",
    lastrevid: 2552211574,
    instanceOf: ["pueblo"],
    population: { amount: 1838, date: "+2022-00-00T00:00:00Z" },
    areaKm2: 240,
    heritage: ["Lugar o Sitio Histórico Nacional"],
    inception: "+1594-00-00T00:00:00Z",
    ...over,
  };
}

describe("stripTrackingParams", () => {
  it("removes every utm_* query param", () => {
    expect(
      stripTrackingParams(
        "https://example.test/a.jpg?utm_source=x&utm_campaign=y&utm_content=z",
      ),
    ).toBe("https://example.test/a.jpg");
  });

  it("keeps non-utm params", () => {
    expect(
      stripTrackingParams("https://example.test/a.jpg?foo=1&utm_source=x&bar=2"),
    ).toBe("https://example.test/a.jpg?foo=1&bar=2");
  });

  it("leaves a clean URL untouched", () => {
    const url = "https://example.test/a.jpg";
    expect(stripTrackingParams(url)).toBe(url);
  });
});

describe("commonsFullImageUrl", () => {
  it("derives a 1600px thumbnail from the thumb URL pattern", () => {
    const thumb =
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/53/" +
      "Calle_en_Purmamarca.jpg/960px-Calle_en_Purmamarca.jpg";
    expect(commonsFullImageUrl(thumb, 4608)).toBe(
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/53/" +
        "Calle_en_Purmamarca.jpg/1600px-Calle_en_Purmamarca.jpg",
    );
  });

  it("caps the thumbnail at the original width", () => {
    const thumb =
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/12/" +
      "Foto.jpg/960px-Foto.jpg";
    expect(commonsFullImageUrl(thumb, 1000)).toBe(
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/12/" +
        "Foto.jpg/1000px-Foto.jpg",
    );
  });

  it("returns the URL unchanged when it is not a thumbnail URL", () => {
    const original =
      "https://upload.wikimedia.org/wikipedia/commons/e/e6/" +
      "Jujuy-Tilcara-Pucara-P3130003.JPG";
    expect(commonsFullImageUrl(original, 800)).toBe(original);
  });
});

describe("wikidataTimeYear", () => {
  it("extracts the year from Wikidata time strings", () => {
    expect(wikidataTimeYear("+2022-00-00T00:00:00Z")).toBe(2022);
    expect(wikidataTimeYear("+1100-00-00T00:00:00Z")).toBe(1100);
    expect(wikidataTimeYear("+1979-07-19T00:00:00Z")).toBe(1979);
    expect(wikidataTimeYear("-0500-01-01T00:00:00Z")).toBe(-500);
  });

  it("returns null for a malformed time string", () => {
    expect(wikidataTimeYear("2022")).toBeNull();
    expect(wikidataTimeYear("")).toBeNull();
  });
});

describe("buildPlacePhoto", () => {
  it("carries the credit fields and cleans the URLs", () => {
    const photo = buildPlacePhoto(stubPhoto());
    expect(photo.thumbUrl).toBe(
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/53/" +
        "Calle_en_Purmamarca.jpg/960px-Calle_en_Purmamarca.jpg",
    );
    expect(photo.fullUrl).toBe(
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/53/" +
        "Calle_en_Purmamarca.jpg/1600px-Calle_en_Purmamarca.jpg",
    );
    expect(photo.width).toBe(1600);
    expect(photo.height).toBe(2133);
    expect(photo.author).toBe("Fotógrafo");
    expect(photo.credit).toBe("https://example.test/credit");
    expect(photo.license).toBe("CC BY 2.0");
    expect(photo.licenseUrl).toBe("https://creativecommons.org/licenses/by/2.0");
    expect(photo.pageUrl).toBe(
      "https://commons.wikimedia.org/wiki/File:Calle_en_Purmamarca.jpg",
    );
    expect(photo.description).toBe("Una calle de Purmamarca");
  });

  it("keeps an original-file URL as its own fullUrl", () => {
    const photo = buildPlacePhoto(
      stubPhoto({
        thumbUrl:
          "https://upload.wikimedia.org/wikipedia/commons/e/e6/Foto.JPG" +
          "?utm_source=commons.wikimedia.org&utm_campaign=imageinfo",
        width: 800,
      }),
    );
    expect(photo.fullUrl).toBe(
      "https://upload.wikimedia.org/wikipedia/commons/e/e6/Foto.JPG",
    );
  });

  it("allows null author, licenseUrl and description", () => {
    const photo = buildPlacePhoto(
      stubPhoto({
        author: null,
        license: "Public domain",
        licenseUrl: null,
        description: null,
      }),
    );
    expect(photo.author).toBeNull();
    expect(photo.licenseUrl).toBeNull();
    expect(photo.description).toBeNull();
  });
});

describe("unattributablePhoto", () => {
  it("flags CC BY* photos with neither author nor credit", () => {
    expect(
      unattributablePhoto(stubPhoto({ author: null, credit: null })),
    ).toBe(true);
    expect(
      unattributablePhoto(
        stubPhoto({
          license: "CC BY-SA 3.0",
          author: null,
          credit: null,
        }),
      ),
    ).toBe(true);
  });

  it("keeps CC BY* photos that name an author or a credit", () => {
    expect(unattributablePhoto(stubPhoto())).toBe(false);
    expect(unattributablePhoto(stubPhoto({ author: null }))).toBe(false);
    expect(unattributablePhoto(stubPhoto({ credit: null }))).toBe(false);
  });

  it("keeps a CC BY* photo with only a credit line", () => {
    expect(
      unattributablePhoto(stubPhoto({ author: null, credit: "Flickr" })),
    ).toBe(false);
  });

  it("ignores licenses outside the allowed list", () => {
    // assertRawCommonsPhotosDoc rejects these before the filter runs.
    expect(
      unattributablePhoto(
        stubPhoto({
          license: "CC BY-NC 4.0",
          author: null,
          credit: null,
        }),
      ),
    ).toBe(false);
  });

  it("allows authorless public domain and CC0 photos", () => {
    expect(
      unattributablePhoto(
        stubPhoto({
          license: "Public domain",
          licenseUrl: null,
          author: null,
          credit: null,
        }),
      ),
    ).toBe(false);
    expect(
      unattributablePhoto(
        stubPhoto({
          license: "CC0",
          licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
          author: null,
          credit: null,
        }),
      ),
    ).toBe(false);
  });
});

describe("buildPlaceExtract", () => {
  it("renames fields and keeps provenance", () => {
    const extract = buildPlaceExtract(stubExtract());
    expect(extract.text).toContain("Purmamarca");
    expect(extract.url).toBe("https://es.wikipedia.org/wiki/Purmamarca");
    expect(extract.revision).toBe("171623733");
    expect(extract.license).toBe("CC BY-SA 4.0");
    expect(extract.licenseUrl).toBe(
      "https://creativecommons.org/licenses/by-sa/4.0/",
    );
  });
});

describe("buildPlaceFacts", () => {
  it("converts the Wikidata time strings into years", () => {
    const facts = buildPlaceFacts(stubFacts());
    expect(facts.instanceOf).toEqual(["pueblo"]);
    expect(facts.population).toEqual({ amount: 1838, year: 2022 });
    expect(facts.areaKm2).toBe(240);
    expect(facts.heritage).toEqual(["Lugar o Sitio Histórico Nacional"]);
    expect(facts.foundedYear).toBe(1594);
  });

  it("emits nulls for the fields the source lacks", () => {
    const facts = buildPlaceFacts(
      stubFacts({
        population: null,
        areaKm2: null,
        heritage: [],
        inception: null,
      }),
    );
    expect(facts.population).toBeNull();
    expect(facts.areaKm2).toBeNull();
    expect(facts.heritage).toEqual([]);
    expect(facts.foundedYear).toBeNull();
  });
});

describe("buildPlaceEntry extras", () => {
  const survey = { demElevationMeters: 2330, department: "Tumbaya" };

  it("defaults to no photos, no extract and no facts", () => {
    const place = buildPlaceEntry(stubRaw(), survey);
    expect(place.photos).toEqual([]);
    expect(place.extract).toBeNull();
    expect(place.facts).toBeNull();
  });

  it("merges the extra content when provided", () => {
    const place = buildPlaceEntry(stubRaw(), survey, {
      photos: [buildPlacePhoto(stubPhoto())],
      extract: buildPlaceExtract(stubExtract()),
      facts: buildPlaceFacts(stubFacts()),
    });
    expect(place.photos).toHaveLength(1);
    expect(place.extract?.revision).toBe("171623733");
    expect(place.facts?.foundedYear).toBe(1594);
  });
});

describe("raw photos/extracts/facts validators", () => {
  it("accepts the committed shapes", () => {
    expect(() =>
      assertRawCommonsPhotosDoc({
        places: [
          { id: "Q1", commonsCategory: "Purmamarca", photos: [stubPhoto()] },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      assertRawWikipediaExtractsDoc({ places: [stubExtract()] }),
    ).not.toThrow();
    expect(() =>
      assertRawWikidataFactsDoc({ places: [stubFacts()] }),
    ).not.toThrow();
  });

  it("rejects unknown fields", () => {
    expect(() =>
      assertRawCommonsPhotosDoc({
        places: [
          {
            id: "Q1",
            commonsCategory: "Purmamarca",
            photos: [{ ...stubPhoto(), extra: 1 }],
          },
        ],
      }),
    ).toThrow(/non-Wikimedia field.*extra/);
    expect(() =>
      assertRawWikipediaExtractsDoc({
        places: [{ ...stubExtract(), html: "<p>x</p>" }],
      }),
    ).toThrow(/non-Wikipedia field.*html/);
    expect(() =>
      assertRawWikidataFactsDoc({
        places: [{ ...stubFacts(), elevation: 100 }],
      }),
    ).toThrow(/non-Wikidata field.*elevation/);
  });

  it("accepts every photo license the card can show", () => {
    for (const license of [
      "CC BY 2.0",
      "CC BY 4",
      "CC BY-SA 2.5",
      "CC BY-SA 4.0",
      "CC0",
      "Public domain",
    ]) {
      expect(() =>
        assertRawCommonsPhotosDoc({
          places: [
            {
              id: "Q1",
              commonsCategory: null,
              photos: [stubPhoto({ license })],
            },
          ],
        }),
      ).not.toThrow();
    }
  });

  it("rejects a photo license the card cannot show, naming the file", () => {
    for (const license of [
      "CC BY-NC 4.0",
      "CC BY-NC-SA 4.0",
      "CC BY-ND 4.0",
      "GFDL",
      "cc by 4.0",
      "FAL",
    ]) {
      expect(() =>
        assertRawCommonsPhotosDoc({
          places: [
            {
              id: "Q1",
              commonsCategory: "Purmamarca",
              photos: [stubPhoto({ license })],
            },
          ],
        }),
      ).toThrow(/Calle en Purmamarca\.jpg.*license the card cannot show/);
    }
  });

  it("rejects malformed entries", () => {
    expect(() =>
      assertRawCommonsPhotosDoc({
        places: [
          {
            id: "Q1",
            commonsCategory: "Purmamarca",
            photos: [{ ...stubPhoto(), width: "big" }],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      assertRawWikipediaExtractsDoc({
        places: [{ ...stubExtract(), revision: 123 }],
      }),
    ).toThrow();
    expect(() =>
      assertRawWikidataFactsDoc({
        places: [
          {
            ...stubFacts(),
            population: { amount: 10, date: "2022" },
          },
        ],
      }),
    ).toThrow();
  });
});

describe("assertPlacesDoc schema v4", () => {
  const survey = { demElevationMeters: 2330, department: "Tumbaya" };
  const entry = buildPlaceEntry(stubRaw(), survey, {
    photos: [buildPlacePhoto(stubPhoto())],
    extract: buildPlaceExtract(stubExtract()),
    facts: buildPlaceFacts(stubFacts()),
  });
  const doc = {
    schemaVersion: PLACES_SCHEMA_VERSION,
    pipelineVersion: 3,
    inputSha256: "0".repeat(64),
    sources: {},
    places: [entry],
  };

  it("accepts a place carrying photos, extract and facts", () => {
    expect(() => assertPlacesDoc(JSON.parse(JSON.stringify(doc)))).not.toThrow();
  });

  it("rejects a photo missing its license or credit field", () => {
    const broken = JSON.parse(JSON.stringify(doc));
    delete broken.places[0].photos[0].license;
    expect(() => assertPlacesDoc(broken)).toThrow();
    const noCredit = JSON.parse(JSON.stringify(doc));
    delete noCredit.places[0].photos[0].credit;
    expect(() => assertPlacesDoc(noCredit)).toThrow();
  });

  it("rejects a built photo with a license the card cannot show", () => {
    const broken = JSON.parse(JSON.stringify(doc));
    broken.places[0].photos[0].license = "CC BY-NC 4.0";
    expect(() => assertPlacesDoc(broken)).toThrow();
  });

  it("rejects a malformed extract and facts", () => {
    const badExtract = JSON.parse(JSON.stringify(doc));
    badExtract.places[0].extract = { text: 5 };
    expect(() => assertPlacesDoc(badExtract)).toThrow();
    const badFacts = JSON.parse(JSON.stringify(doc));
    badFacts.places[0].facts = { instanceOf: "pueblo" };
    expect(() => assertPlacesDoc(badFacts)).toThrow();
  });
});
