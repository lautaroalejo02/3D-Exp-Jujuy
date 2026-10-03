/**
 * Pure helpers for the Sol sheet: Argentina-local time math, the
 * sunrise/sunset slider window and the sun-arc indicator geometry.
 * No DOM, no GPU — everything here is unit-tested (sol-clock.test.ts).
 *
 * Local time means Argentina time (UTC−3, no DST), the same convention
 * as src/sun/solar.ts.
 */
import {
  ARGENTINA_UTC_OFFSET_MS,
  sunriseSunset,
} from "../../sun/solar";

/** A civil date in Argentina local time; `month` is 1-based. */
export interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** Extra minutes of twilight the slider allows before sunrise / after sunset. */
export const TWILIGHT_PAD_MINUTES = 30;

const MINUTES_PER_DAY = 1440;

/**
 * Minutes since local midnight -> the UTC instant. Fractional minutes
 * pass through so the play animation advances smoothly.
 */
export function localInstantUtc(date: LocalDate, minutes: number): Date {
  return new Date(
    Date.UTC(date.year, date.month - 1, date.day) -
      ARGENTINA_UTC_OFFSET_MS +
      minutes * 60_000,
  );
}

/** The Argentina civil date containing `now` (defaults to the real now). */
export function localToday(now: Date = new Date()): LocalDate {
  const local = new Date(now.getTime() + ARGENTINA_UTC_OFFSET_MS);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
  };
}

/** Minutes since local midnight for a UTC instant (can exceed [0,1440)). */
export function localMinutesOfUtc(utc: Date, date: LocalDate): number {
  return (
    (utc.getTime() + ARGENTINA_UTC_OFFSET_MS -
      Date.UTC(date.year, date.month - 1, date.day)) /
    60_000
  );
}

/** The Argentina local clock time of `now`, in minutes since local midnight. */
export function localMinutesNow(now: Date = new Date()): number {
  return localMinutesOfUtc(now, localToday(now));
}

export interface DayWindow {
  /** Local minutes of apparent sunrise (NOAA 90.833° zenith). */
  readonly sunriseMinutes: number;
  /** Local minutes of apparent sunset. */
  readonly sunsetMinutes: number;
  /** Slider range: sunrise − pad .. sunset + pad, clamped to the day. */
  readonly min: number;
  readonly max: number;
}

/**
 * Sunrise/sunset in local minutes for one local date at (latDeg, lonDeg),
 * plus the slider bounds padded with twilight on both sides. Undefined
 * when the sun never crosses the horizon that day (polar day/night —
 * unreachable inside Jujuy, kept for safety).
 */
export function dayWindow(
  date: LocalDate,
  latDeg: number,
  lonDeg: number,
  padMinutes: number = TWILIGHT_PAD_MINUTES,
): DayWindow | undefined {
  const times = sunriseSunset(
    new Date(Date.UTC(date.year, date.month - 1, date.day, 12)),
    latDeg,
    lonDeg,
  );
  if (!times) return undefined;
  const sunriseMinutes = localMinutesOfUtc(times.sunrise, date);
  const sunsetMinutes = localMinutesOfUtc(times.sunset, date);
  return {
    sunriseMinutes,
    sunsetMinutes,
    min: Math.max(0, sunriseMinutes - padMinutes),
    max: Math.min(MINUTES_PER_DAY - 1, sunsetMinutes + padMinutes),
  };
}

/**
 * Position along the day arc: 0 at sunrise, 1 at sunset; below 0 or
 * above 1 inside the twilight pad or at night (the caller dims the dot).
 */
export function arcProgress(
  minutes: number,
  window: Pick<DayWindow, "sunriseMinutes" | "sunsetMinutes">,
): number {
  return (
    (minutes - window.sunriseMinutes) /
    (window.sunsetMinutes - window.sunriseMinutes)
  );
}

/** SVG geometry shared by sunArcPoint and the sheet's arc drawing. */
export const ARC_CX = 50;
export const ARC_CY = 42;
export const ARC_R = 38;

/**
 * Point on the sunrise->sunset semicircle for a 0..1 progress, in the
 * arc SVG's "0 0 100 46" coordinates (left end at t=0, top at t=0.5).
 */
export function sunArcPoint(t: number): readonly [number, number] {
  const angle = Math.PI * t;
  return [ARC_CX - ARC_R * Math.cos(angle), ARC_CY - ARC_R * Math.sin(angle)];
}

/** "18:43" — 24 h clock, hours zero-padded. */
export function formatHourMin(minutes: number): string {
  const m = ((Math.round(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) %
    MINUTES_PER_DAY;
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2, "0")}:${String(m - h * 60).padStart(2, "0")}`;
}

/** "40,7°" — one decimal with the Argentine decimal comma. */
export function formatDeg(deg: number): string {
  return `${deg.toFixed(1).replace(".", ",")}°`;
}

/** "2026-06-21" — the native date input's value format. */
export function formatDateValue(date: LocalDate): string {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(
    date.day,
  ).padStart(2, "0")}`;
}

/** Parse the native date input's "YYYY-MM-DD" value; undefined when invalid. */
export function parseDateValue(value: string): LocalDate | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return { year, month, day };
}
