import { describe, expect, it } from "vitest";

import {
  angularDistanceDeg,
  ARGENTINA_UTC_OFFSET_MS,
  argentinaLocalToUtc,
  skyAmbientColor,
  skyTintColor,
  solarPosition,
  sunColor,
  sunDirectionWorld,
  sunriseSunset,
  summerSolstice,
  today,
  winterSolstice,
} from "./solar";

/**
 * Reference point: San Salvador de Jujuy.
 * Coordinates from the task spec (matches the city's Wikidata P625 of
 * Q44217 — https://www.wikidata.org/wiki/Q44217).
 */
const JUJUY = { lat: -24.1856, lon: -65.2994 } as const;

/**
 * Reference values below are cross-checked against two independent
 * sources (recorded 2026-10-03):
 *
 * 1. PySolar 0.13 (python package, independent solar-position
 *    implementation) — `pysolar.solar.get_altitude` (apparent elevation
 *    with refraction) and `get_azimuth` (degrees clockwise from north).
 *    The implementation itself follows the NOAA Solar Calculator
 *    equations: https://gml.noaa.gov/grad/solcalc/solareqns.PDF
 *    (calculator UI: https://gml.noaa.gov/grad/solcalc/azel.html).
 *    Tolerance 0.5 degrees.
 *
 * 2. sunrise-sunset.org API (apparent rise/set = upper limb at the
 *    horizon with refraction, same 90.833 deg zenith convention as
 *    NOAA): https://api.sunrise-sunset.org/json
 *    ?lat=-24.1856&lng=-65.2994&date=2026-06-21&formatted=0
 *    Tolerance 3 minutes.
 */
const POSITION_CASES: readonly {
  name: string;
  utc: string;
  elevationDeg: number;
  azimuthDeg: number;
}[] = [
  {
    name: "winter solstice 12:30 ART",
    utc: "2026-06-21T15:30:00Z",
    elevationDeg: 40.6886,
    azimuthDeg: 16.1047,
  },
  {
    name: "winter solstice 18:00 ART",
    utc: "2026-06-21T21:00:00Z",
    elevationDeg: 7.8012,
    azimuthDeg: 300.0409,
  },
  {
    name: "winter solstice 09:00 ART",
    utc: "2026-06-21T12:00:00Z",
    elevationDeg: 10.5007,
    azimuthDeg: 58.2714,
  },
  {
    name: "summer solstice 12:30 ART",
    utc: "2026-12-21T15:30:00Z",
    elevationDeg: 78.7021,
    azimuthDeg: 88.7096,
  },
  {
    name: "summer solstice 09:00 ART",
    utc: "2026-12-21T12:00:00Z",
    elevationDeg: 31.3016,
    azimuthDeg: 103.7287,
  },
  {
    name: "summer solstice 18:00 ART",
    utc: "2026-12-21T21:00:00Z",
    elevationDeg: 26.5983,
    azimuthDeg: 254.7574,
  },
  {
    name: "2026-10-03 13:00 ART",
    utc: "2026-10-03T16:00:00Z",
    elevationDeg: 69.8125,
    azimuthDeg: 7.3467,
  },
];

describe("solarPosition", () => {
  for (const c of POSITION_CASES) {
    it(`${c.name}: elevation ${c.elevationDeg} deg, azimuth ${c.azimuthDeg} deg`, () => {
      const pos = solarPosition(new Date(c.utc), JUJUY.lat, JUJUY.lon);
      expect(Math.abs(pos.elevationDeg - c.elevationDeg)).toBeLessThan(0.5);
      // Azimuth wraps at 360; compare on the unit circle.
      const diff = Math.abs(pos.azimuthDeg - c.azimuthDeg) % 360;
      expect(Math.min(diff, 360 - diff)).toBeLessThan(0.5);
      expect(pos.elevationDeg).toBeLessThanOrEqual(90);
    });
  }

  it("reports the sun below the horizon at night", () => {
    const pos = solarPosition(
      new Date("2026-06-21T03:00:00Z"), // 00:00 ART
      JUJUY.lat,
      JUJUY.lon,
    );
    expect(pos.elevationDeg).toBeLessThan(-6);
  });
});

describe("sunDirectionWorld", () => {
  it("maps the fixed NW 45 deg cartographic light exactly", () => {
    const [x, y, z] = sunDirectionWorld(315, 45);
    // Same vector as SUN_DIR in terrain.wgsl: X east, Y up, Z south.
    expect(x).toBeCloseTo(-0.5, 6);
    expect(y).toBeCloseTo(Math.SQRT1_2, 6);
    expect(z).toBeCloseTo(-0.5, 6);
  });

  it("points east at azimuth 90, south at 180, and is unit length", () => {
    const e = sunDirectionWorld(90, 10);
    expect(e[0]).toBeGreaterThan(0.98);
    const s = sunDirectionWorld(180, 10);
    expect(s[2]).toBeGreaterThan(0.98);
    for (const az of [0, 90, 180, 300]) {
      const d = sunDirectionWorld(az, 7.8);
      expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 6);
    }
  });
});

describe("angularDistanceDeg", () => {
  it("is zero for identical directions", () => {
    const d = sunDirectionWorld(300, 7.8);
    expect(angularDistanceDeg(d, d)).toBeCloseTo(0, 9);
  });

  it("measures the angle between two sun directions", () => {
    // Same azimuth, 0.3 deg of elevation apart.
    const a = sunDirectionWorld(300, 7.8);
    const b = sunDirectionWorld(300, 8.1);
    expect(angularDistanceDeg(a, b)).toBeCloseTo(0.3, 3);
    // 90 deg apart in azimuth at the same low elevation is much larger
    // than the 0.25 deg shadow-recompute threshold.
    const c = sunDirectionWorld(0, 30);
    const e = sunDirectionWorld(90, 30);
    expect(angularDistanceDeg(c, e)).toBeGreaterThan(1);
  });
});

describe("argentinaLocalToUtc", () => {
  it("converts ART (UTC-3, no DST) to UTC", () => {
    expect(argentinaLocalToUtc(2026, 6, 21, 18, 0).toISOString()).toBe(
      "2026-06-21T21:00:00.000Z",
    );
    expect(ARGENTINA_UTC_OFFSET_MS).toBe(-3 * 3_600_000);
  });
});

/**
 * Published solstice instants (UTC), from timeanddate.com's
 * equinox/solstice listings. Ours are computed with the NOAA solar
 * equations — https://gml.noaa.gov/grad/solcalc/solareqns.PDF — by
 * searching the declination extremum to the hour; tolerance one day.
 */
const SOLSTICES: readonly {
  year: number;
  juneUtc: string;
  decemberUtc: string;
}[] = [
  { year: 2024, juneUtc: "2024-06-20T20:51:00Z", decemberUtc: "2024-12-21T09:20:00Z" },
  { year: 2025, juneUtc: "2025-06-21T02:42:00Z", decemberUtc: "2025-12-21T15:03:00Z" },
  { year: 2026, juneUtc: "2026-06-21T08:25:00Z", decemberUtc: "2026-12-21T20:50:00Z" },
  { year: 2027, juneUtc: "2027-06-21T14:11:00Z", decemberUtc: "2027-12-22T02:42:00Z" },
  { year: 2028, juneUtc: "2028-06-20T20:02:00Z", decemberUtc: "2028-12-21T08:20:00Z" },
  { year: 2029, juneUtc: "2029-06-21T01:48:00Z", decemberUtc: "2029-12-21T14:14:00Z" },
  { year: 2030, juneUtc: "2030-06-21T07:31:00Z", decemberUtc: "2030-12-21T20:09:00Z" },
];

describe("solstices", () => {
  const DAY_MS = 24 * 3_600_000;
  const localDate = (utc: Date): Date =>
    new Date(utc.getTime() + ARGENTINA_UTC_OFFSET_MS);

  for (const s of SOLSTICES) {
    it(`${s.year}: winter solstice falls on a Jun 20-22 local date`, () => {
      const d = winterSolstice(s.year);
      const local = localDate(d);
      expect(local.getUTCMonth()).toBe(5); // June, in ART
      expect(local.getUTCDate()).toBeGreaterThanOrEqual(20);
      expect(local.getUTCDate()).toBeLessThanOrEqual(22);
      expect(Math.abs(d.getTime() - Date.parse(s.juneUtc))).toBeLessThanOrEqual(
        DAY_MS,
      );
    });

    it(`${s.year}: summer solstice falls on a Dec 20-22 local date`, () => {
      const d = summerSolstice(s.year);
      const local = localDate(d);
      expect(local.getUTCMonth()).toBe(11); // December, in ART
      expect(local.getUTCDate()).toBeGreaterThanOrEqual(20);
      expect(local.getUTCDate()).toBeLessThanOrEqual(22);
      expect(
        Math.abs(d.getTime() - Date.parse(s.decemberUtc)),
      ).toBeLessThanOrEqual(DAY_MS);
    });
  }
});

describe("presets", () => {
  it("today returns today's date at the given local time", () => {
    const d = today(9, 30);
    const shifted = new Date(d.getTime() + ARGENTINA_UTC_OFFSET_MS);
    expect(shifted.getUTCHours()).toBe(9);
    expect(shifted.getUTCMinutes()).toBe(30);
  });
});

describe("sunriseSunset", () => {
  // sunrise-sunset.org reference values (UTC), lat -24.1856 lon -65.2994.
  it("winter solstice 2026-06-21", () => {
    const times = sunriseSunset(
      new Date("2026-06-21T00:00:00Z"),
      JUJUY.lat,
      JUJUY.lon,
    );
    expect(times).toBeDefined();
    // Reference: sunrise 11:02:38Z, sunset 21:43:29Z.
    expect(
      Math.abs(times!.sunrise.getTime() - Date.parse("2026-06-21T11:02:38Z")),
    ).toBeLessThan(3 * 60_000);
    expect(
      Math.abs(times!.sunset.getTime() - Date.parse("2026-06-21T21:43:29Z")),
    ).toBeLessThan(3 * 60_000);
  });

  it("summer solstice 2026-12-21", () => {
    const times = sunriseSunset(
      new Date("2026-12-21T00:00:00Z"),
      JUJUY.lat,
      JUJUY.lon,
    );
    expect(times).toBeDefined();
    // Reference: sunrise 09:29:03Z, sunset 23:09:39Z.
    expect(
      Math.abs(times!.sunrise.getTime() - Date.parse("2026-12-21T09:29:03Z")),
    ).toBeLessThan(3 * 60_000);
    expect(
      Math.abs(times!.sunset.getTime() - Date.parse("2026-12-21T23:09:39Z")),
    ).toBeLessThan(3 * 60_000);
  });
});

describe("sun and sky colors", () => {
  it("sun light is neutral white at high elevation", () => {
    const c = sunColor(45);
    expect(c[0]).toBeCloseTo(c[1], 3);
    expect(c[1]).toBeCloseTo(c[2], 3);
    expect(c[0]).toBeGreaterThan(0.9);
  });

  it("sun light turns warm near the horizon", () => {
    const c = sunColor(4);
    expect(c[0]).toBeGreaterThan(c[1]);
    expect(c[1]).toBeGreaterThan(c[2]);
    expect(c[0]).toBeGreaterThan(0.5);
  });

  it("direct light dies below the horizon", () => {
    const c = sunColor(-8);
    expect(c[0]).toBe(0);
    expect(c[1]).toBe(0);
    expect(c[2]).toBe(0);
  });

  it("ambient falls back to a dim blue at night", () => {
    const night = skyAmbientColor(-8);
    expect(night[2]).toBeGreaterThan(night[0]);
    expect(Math.max(...night)).toBeLessThan(0.25);
    const day = skyAmbientColor(45);
    expect(Math.min(...day)).toBeGreaterThan(0.3);
  });

  it("sky tint is neutral by day, warm at dusk, dark at night", () => {
    const day = skyTintColor(45);
    expect(day[0]).toBeGreaterThan(0.95);
    const dusk = skyTintColor(4);
    expect(dusk[0]).toBeGreaterThan(dusk[2]);
    const night = skyTintColor(-8);
    expect(Math.max(...night)).toBeLessThan(0.4);
    expect(night[2]).toBeGreaterThan(night[0]);
  });
});
