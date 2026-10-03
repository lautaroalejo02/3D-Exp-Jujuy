import { describe, expect, it } from "vitest";

import {
  arcProgress,
  dayWindow,
  formatDateValue,
  formatDeg,
  formatHourMin,
  localInstantUtc,
  localMinutesNow,
  localToday,
  parseDateValue,
  sunArcPoint,
  TWILIGHT_PAD_MINUTES,
  type LocalDate,
} from "./sol-clock";

/**
 * Same reference point as solar.test.ts: San Salvador de Jujuy
 * (Wikidata P625 of Q44217 — https://www.wikidata.org/wiki/Q44217).
 */
const JUJUY = { lat: -24.1856, lon: -65.2994 } as const;

const WINTER: LocalDate = { year: 2026, month: 6, day: 21 };

describe("localInstantUtc", () => {
  it("maps local minutes (ART, UTC-3) to the UTC instant", () => {
    expect(localInstantUtc(WINTER, 18 * 60).toISOString()).toBe(
      "2026-06-21T21:00:00.000Z",
    );
    expect(localInstantUtc(WINTER, 0).toISOString()).toBe(
      "2026-06-21T03:00:00.000Z",
    );
  });

  it("carries fractional minutes (slider scrubs are continuous)", () => {
    const utc = localInstantUtc(WINTER, 18 * 60 + 30.5);
    expect(utc.getUTCMinutes()).toBe(30);
    expect(utc.getUTCSeconds()).toBe(30);
  });
});

describe("localToday / localMinutesNow", () => {
  it("derives the Argentina local date from a UTC instant", () => {
    // 2026-06-21T23:30Z is 20:30 ART — still the 21st locally.
    expect(localToday(new Date("2026-06-21T23:30:00Z"))).toEqual(WINTER);
    // 02:30Z is 23:30 ART the previous day.
    expect(localToday(new Date("2026-06-22T02:30:00Z"))).toEqual({
      year: 2026,
      month: 6,
      day: 21,
    });
  });

  it("derives local minutes since local midnight", () => {
    expect(localMinutesNow(new Date("2026-06-21T21:30:00Z"))).toBeCloseTo(
      18 * 60 + 30,
      6,
    );
  });
});

describe("dayWindow", () => {
  it("bounds the slider around winter-solstice sunrise/sunset +/- twilight", () => {
    // sunrise-sunset.org reference for 2026-06-21: sunrise 11:02:38Z,
    // sunset 21:43:29Z -> 08:02:38 and 18:43:29 ART.
    const w = dayWindow(WINTER, JUJUY.lat, JUJUY.lon)!;
    expect(w).toBeDefined();
    expect(Math.abs(w.sunriseMinutes - (8 * 60 + 2.63))).toBeLessThan(2);
    expect(Math.abs(w.sunsetMinutes - (18 * 60 + 43.48))).toBeLessThan(2);
    expect(w.min).toBeCloseTo(w.sunriseMinutes - TWILIGHT_PAD_MINUTES, 6);
    expect(w.max).toBeCloseTo(w.sunsetMinutes + TWILIGHT_PAD_MINUTES, 6);
  });

  it("gives the longer summer-solstice day a wider window", () => {
    const winter = dayWindow(WINTER, JUJUY.lat, JUJUY.lon)!;
    const summer = dayWindow(
      { year: 2026, month: 12, day: 21 },
      JUJUY.lat,
      JUJUY.lon,
    )!;
    expect(summer.sunriseMinutes).toBeLessThan(winter.sunriseMinutes);
    expect(summer.sunsetMinutes).toBeGreaterThan(winter.sunsetMinutes);
  });
});

describe("arcProgress", () => {
  const w = {
    sunriseMinutes: 480,
    sunsetMinutes: 1120,
    min: 450,
    max: 1150,
  };

  it("is 0 at sunrise, 0.5 at midday, 1 at sunset", () => {
    expect(arcProgress(480, w)).toBeCloseTo(0, 6);
    expect(arcProgress(800, w)).toBeCloseTo(0.5, 6);
    expect(arcProgress(1120, w)).toBeCloseTo(1, 6);
  });

  it("goes outside [0,1] inside the twilight pad (night ends)", () => {
    expect(arcProgress(450, w)).toBeLessThan(0);
    expect(arcProgress(1150, w)).toBeGreaterThan(1);
  });
});

describe("sunArcPoint", () => {
  it("starts at the left end, tops at midday, ends at the right end", () => {
    const [x0, y0] = sunArcPoint(0);
    const [x1, y1] = sunArcPoint(0.5);
    const [x2, y2] = sunArcPoint(1);
    expect(y0).toBeCloseTo(y2, 6); // both ends on the horizon line
    expect(y1).toBeLessThan(y0); // midday dot above the horizon (y grows down)
    expect(x0).toBeLessThan(x1);
    expect(x1).toBeLessThan(x2);
  });
});

describe("formatting", () => {
  it("formats minutes as HH:MM (24 h clock)", () => {
    expect(formatHourMin(8 * 60 + 2.63)).toBe("08:03");
    expect(formatHourMin(18 * 60 + 43.4)).toBe("18:43");
    expect(formatHourMin(0)).toBe("00:00");
  });

  it("formats degrees with the Argentine decimal comma", () => {
    expect(formatDeg(40.6886)).toBe("40,7°");
    expect(formatDeg(-0.26)).toBe("-0,3°");
  });

  it("formats/parses the date input value", () => {
    expect(formatDateValue(WINTER)).toBe("2026-06-21");
    expect(parseDateValue("2026-06-21")).toEqual(WINTER);
    expect(parseDateValue("21/06/2026")).toBeUndefined();
    expect(parseDateValue("")).toBeUndefined();
  });
});
