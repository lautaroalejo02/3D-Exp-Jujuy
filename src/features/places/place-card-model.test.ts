import { describe, expect, it } from "vitest";

import type {
  Place,
  PlaceExtract,
  PlaceFacts,
  PlacePhoto,
} from "../../terrain/places-manifest";
import {
  photoCreditLine,
  placeCardModel,
  placeFactRows,
} from "./place-card-model";

function stubPhoto(over: Partial<PlacePhoto> = {}): PlacePhoto {
  return {
    thumbUrl: "https://thumb.wikimedia.org/a/480px-Foto.jpg",
    fullUrl: "https://thumb.wikimedia.org/a/1600px-Foto.jpg",
    width: 1600,
    height: 1200,
    author: "Fotógrafo",
    credit: "Own work",
    license: "CC BY-SA 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/",
    pageUrl: "https://commons.wikimedia.org/wiki/File:Foto.jpg",
    description: "Una foto del lugar",
    ...over,
  };
}

function stubExtract(over: Partial<PlaceExtract> = {}): PlaceExtract {
  return {
    text: "Purmamarca es una localidad del departamento de Tumbaya.",
    url: "https://es.wikipedia.org/wiki/Purmamarca",
    revision: "171623733",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    ...over,
  };
}

function stubFacts(over: Partial<PlaceFacts> = {}): PlaceFacts {
  return {
    instanceOf: ["pueblo"],
    population: { amount: 1838, year: 2022 },
    areaKm2: 240,
    heritage: ["Lugar o Sitio Histórico Nacional"],
    foundedYear: 1594,
    ...over,
  };
}

function stubPlace(over: Partial<Place> = {}): Place {
  return {
    id: "Q1",
    name: "Purmamarca",
    description: "localidad de la provincia de Jujuy, Argentina",
    lat: -23.74,
    lon: -65.49,
    coordinateSource: "wikidata",
    elevationMeters: 2329,
    elevationSource: "dem",
    demElevationMeters: 2329,
    department: "Tumbaya",
    wikidataUrl: "https://www.wikidata.org/wiki/Q1",
    eswikiUrl: "https://es.wikipedia.org/wiki/Purmamarca",
    photos: [stubPhoto()],
    extract: stubExtract(),
    facts: stubFacts(),
    ...over,
  };
}

describe("placeFactRows", () => {
  it("lists the five facts in order, formatted for the card", () => {
    expect(placeFactRows(stubFacts())).toEqual([
      { label: "Tipo", value: "Pueblo" },
      { label: "Población", value: "1.838 (2022)" },
      { label: "Superficie", value: "240 km²" },
      { label: "Patrimonio", value: "Lugar o Sitio Histórico Nacional" },
      { label: "Fundación", value: "1594" },
    ]);
  });

  it("omits the rows that have no data", () => {
    expect(
      placeFactRows({
        instanceOf: [],
        population: null,
        areaKm2: null,
        heritage: [],
        foundedYear: null,
      }),
    ).toEqual([]);
    expect(placeFactRows(null)).toEqual([]);
    expect(
      placeFactRows(stubFacts({ population: null, foundedYear: null })).map(
        (r) => r.label,
      ),
    ).toEqual(["Tipo", "Superficie", "Patrimonio"]);
  });

  it("formats decimal areas with a comma", () => {
    expect(placeFactRows(stubFacts({ areaKm2: 162.24 }))[2]?.value).toBe(
      "162,24 km²",
    );
    expect(placeFactRows(stubFacts({ areaKm2: 76.3 }))[2]?.value).toBe(
      "76,3 km²",
    );
  });

  it("joins multiple types and heritage designations", () => {
    const rows = placeFactRows(
      stubFacts({
        instanceOf: ["fortaleza", "yacimiento arqueológico"],
        heritage: ["Monumento Histórico Nacional de Argentina", "Otro"],
      }),
    );
    expect(rows[0]?.value).toBe("Fortaleza, yacimiento arqueológico");
    expect(rows[3]?.value).toBe(
      "Monumento Histórico Nacional de Argentina, Otro",
    );
  });
});

describe("photoCreditLine", () => {
  it("pairs author and license with their links", () => {
    expect(photoCreditLine(stubPhoto())).toEqual({
      author: "Fotógrafo",
      authorUrl: "https://commons.wikimedia.org/wiki/File:Foto.jpg",
      license: "CC BY-SA 3.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/",
    });
  });

  it("shows the Commons credit line when the file reports no author", () => {
    const credit = photoCreditLine(
      stubPhoto({ author: null, credit: "Flickr user peregrino" }),
    );
    expect(credit.author).toBe("Flickr user peregrino");
    expect(credit.authorUrl).toBe(
      "https://commons.wikimedia.org/wiki/File:Foto.jpg",
    );
  });

  it("handles a public domain photo without author or license URL", () => {
    const credit = photoCreditLine(
      stubPhoto({
        author: null,
        credit: null,
        license: "Public domain",
        licenseUrl: null,
      }),
    );
    expect(credit.author).toBeNull();
    expect(credit.license).toBe("Public domain");
    expect(credit.licenseUrl).toBeNull();
  });
});

describe("placeCardModel", () => {
  it("collapsed rows keep Región and Altura only", () => {
    const model = placeCardModel(stubPlace(), "Quebrada");
    const collapsed = model.rows.filter((r) => !r.expandedOnly);
    expect(collapsed.map((r) => r.label)).toEqual(["Región", "Altura"]);
    expect(collapsed[0]?.value).toBe("Quebrada");
    expect(collapsed[1]?.value).toBe("2.329 m s. n. m.");
  });

  it("expanded rows add Departamento and the coordinates", () => {
    const model = placeCardModel(stubPlace(), "Quebrada");
    const expanded = model.rows.filter((r) => r.expandedOnly);
    expect(expanded.map((r) => r.label)).toEqual([
      "Departamento",
      "Latitud",
      "Longitud",
    ]);
    expect(expanded[0]?.value).toBe("Tumbaya");
    expect(expanded[1]?.value).toBe("23,7400° S");
    expect(expanded[2]?.value).toBe("65,4900° O");
  });

  it("keeps the full row order Departamento, Región, Altura, Latitud, Longitud", () => {
    const model = placeCardModel(stubPlace(), "Quebrada");
    expect(model.rows.map((r) => r.label)).toEqual([
      "Departamento",
      "Región",
      "Altura",
      "Latitud",
      "Longitud",
    ]);
  });

  it("omits the Región row when the lookup is absent", () => {
    const model = placeCardModel(stubPlace());
    expect(model.rows.map((r) => r.label)).toEqual([
      "Departamento",
      "Altura",
      "Latitud",
      "Longitud",
    ]);
  });

  it("carries the extract with its source line and revision link", () => {
    const model = placeCardModel(stubPlace());
    expect(model.extract).toEqual({
      text: "Purmamarca es una localidad del departamento de Tumbaya.",
      url: "https://es.wikipedia.org/wiki/Purmamarca",
      revisionUrl:
        "https://es.wikipedia.org/w/index.php?oldid=171623733",
      license: "CC BY-SA 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
      sourceLine: "Fuente: Wikipedia (CC BY-SA 4.0)",
    });
  });

  it("exposes the photos unchanged for the strip and lightbox", () => {
    const place = stubPlace();
    const model = placeCardModel(place);
    expect(model.photos).toBe(place.photos);
    expect(placeCardModel(stubPlace({ photos: [] })).photos).toEqual([]);
  });

  it("falls back to 'Sin descripción' and reports it", () => {
    const model = placeCardModel(stubPlace({ description: null }));
    expect(model.description).toBe("Sin descripción");
    expect(model.hasDescription).toBe(false);
  });

  it("keeps the outgoing links", () => {
    const model = placeCardModel(stubPlace());
    expect(model.links).toEqual([
      { label: "Ver en Wikidata", url: "https://www.wikidata.org/wiki/Q1" },
      {
        label: "Artículo en Wikipedia",
        url: "https://es.wikipedia.org/wiki/Purmamarca",
      },
    ]);
    const noWiki = placeCardModel(stubPlace({ eswikiUrl: null }));
    expect(noWiki.links).toHaveLength(1);
  });
});
