/**
 * Solar position and sun/sky lighting for the "Sol" mode. Pure functions:
 * no DOM, no GPU, fully unit-tested against NOAA Solar Calculator
 * reference values (see solar.test.ts).
 *
 * Algorithm: NOAA solar equations (fractional year, equation of time,
 * declination, hour angle, zenith with the standard refraction
 * correction, azimuth clockwise from north), per
 * https://gml.noaa.gov/grad/solcalc/solareqns.PDF
 *
 * Azimuth convention: degrees clockwise from north (0 = N, 90 = E,
 * 180 = S, 270 = W). Elevation is the APPARENT elevation including the
 * atmospheric refraction correction NOAA applies (the sun appears ~0.5°
 * above its geometric position at the horizon).
 *
 * Timezone: Argentina runs UTC−3 all year (no DST since 2009).
 */

const DEG = Math.PI / 180;
const MINUTES_PER_DAY = 1440;

/** Argentina local time offset from UTC, in milliseconds (UTC−3). */
export const ARGENTINA_UTC_OFFSET_MS = -3 * 3_600_000;

export interface SolarPosition {
  /** Apparent elevation above the horizon in degrees (with refraction). */
  readonly elevationDeg: number;
  /** Azimuth in degrees clockwise from north: 0 = N, 90 = E, 180 = S. */
  readonly azimuthDeg: number;
  /** Geometric zenith angle in degrees (no refraction). */
  readonly zenithDeg: number;
}

/** Day of year (1..366) and fraction of day (0..1), both in UTC. */
function dayOfYearUtc(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((d.getTime() - start) / 86_400_000) + 1;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * NOAA equation of time (minutes) and solar declination (radians) for a
 * UTC instant, from the fractional year. Using UTC consistently keeps
 * both terms within the equation's own ~0.01 rad accuracy.
 */
function equationOfTimeAndDeclination(d: Date): {
  readonly eqTimeMinutes: number;
  readonly declinationRad: number;
} {
  const doy = dayOfYearUtc(d);
  const daysInYear = isLeapYear(d.getUTCFullYear()) ? 366 : 365;
  const hour =
    d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  const gamma = ((2 * Math.PI) / daysInYear) * (doy - 1 + (hour - 12) / 24);
  const eqTimeMinutes =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));
  const declinationRad =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
      0.00148 * Math.sin(3 * gamma);
  return { eqTimeMinutes, declinationRad };
}

/** NOAA refraction correction in degrees, for a geometric elevation. */
function refractionDeg(elevationDeg: number): number {
  const el = elevationDeg * DEG;
  const tan = Math.tan(el);
  if (elevationDeg > 85) return 0;
  if (elevationDeg > 5) {
    return (
      (58.1 / tan - 0.07 / tan ** 3 + 0.000086 / tan ** 5) / 3600
    );
  }
  if (elevationDeg > -0.575) {
    return (
      (1735 +
        elevationDeg *
          (-518.2 +
            elevationDeg *
              (103.4 + elevationDeg * (-12.79 + elevationDeg * 0.711)))) /
      3600
    );
  }
  return -20.772 / tan / 3600;
}

/**
 * Apparent solar position for a UTC instant at (latDeg, lonDeg);
 * longitude positive east, latitude positive north.
 */
export function solarPosition(
  utc: Date,
  latDeg: number,
  lonDeg: number,
): SolarPosition {
  const { eqTimeMinutes, declinationRad } = equationOfTimeAndDeclination(utc);
  const lat = latDeg * DEG;
  const decl = declinationRad;

  // True solar time: UTC minutes + equation of time + longitude offset.
  const utcMinutes = utc.getUTCHours() * 60 + utc.getUTCMinutes();
  let tst = utcMinutes + eqTimeMinutes + 4 * lonDeg;
  tst = ((tst % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hourAngle = (tst / 4 - 180) * DEG;

  const cosZenith =
    Math.sin(lat) * Math.sin(decl) +
    Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
  const zenithRad = Math.acos(Math.min(1, Math.max(-1, cosZenith)));
  const elevation = 90 - zenithRad / DEG;

  // Azimuth clockwise from north via the ENU components: east and north
  // parts of the unit vector pointing at the sun.
  const east = -Math.cos(decl) * Math.sin(hourAngle);
  const north =
    Math.cos(lat) * Math.sin(decl) -
    Math.sin(lat) * Math.cos(decl) * Math.cos(hourAngle);
  const azimuthDeg =
    ((Math.atan2(east, north) / DEG) % 360 + 360) % 360;

  return {
    elevationDeg: elevation + refractionDeg(elevation),
    azimuthDeg,
    zenithDeg: zenithRad / DEG,
  };
}

/**
 * Unit vector pointing TO the sun in world space: X east, Y up, Z south
 * (the same convention as gridToWorld in src/geo and the SUN_DIR
 * constants the terrain/diorama/detail shaders used to hardcode).
 */
export function sunDirectionWorld(
  azimuthDeg: number,
  elevationDeg: number,
): readonly [number, number, number] {
  const az = azimuthDeg * DEG;
  const el = elevationDeg * DEG;
  const cosEl = Math.cos(el);
  return [
    Math.sin(az) * cosEl,
    Math.sin(el),
    -Math.cos(az) * cosEl,
  ];
}

/**
 * Angle between two unit direction vectors, in degrees. Used by the
 * shadow engine to skip recomputes when the sun barely moved.
 */
export function angularDistanceDeg(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.min(1, Math.max(-1, dot))) / DEG;
}

/**
 * Argentina local date/time -> UTC instant. Argentina keeps UTC−3 all
 * year; there is no daylight-saving adjustment to consider.
 */
export function argentinaLocalToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  return new Date(
    Date.UTC(year, month - 1, day, hour, minute) - ARGENTINA_UTC_OFFSET_MS,
  );
}

/**
 * UTC instant of a solstice, to the hour: the extremum of the NOAA
 * solar declination around the 21st of the solstice month. The
 * declination stays within ~1e-4 rad of its peak for a full day, so a
 * plain hourly argmax drifts up to a day off the true instant —
 * instead the hourly samples over +/-4 days are projected onto the
 * annual sine/cosine and the fitted phase locates the extremum of the
 * dominant yearly harmonic (matches published instants to ~half a
 * day; the caller only needs the Argentina-local date).
 */
function solsticeUtc(year: number, month: 6 | 12): Date {
  const center = Date.UTC(year, month - 1, 21, 12);
  const omega = (2 * Math.PI) / (365 * 24); // annual frequency, per hour
  const sign = month === 6 ? 1 : -1;
  let sCos = 0;
  let sSin = 0;
  for (let h = -4 * 24; h < 4 * 24; h++) {
    const decl =
      sign *
      equationOfTimeAndDeclination(new Date(center + h * 3_600_000))
        .declinationRad;
    sCos += decl * Math.cos(omega * h);
    sSin += decl * Math.sin(omega * h);
  }
  const peakHours = Math.atan2(sSin, sCos) / omega;
  return new Date(center + Math.round(peakHours) * 3_600_000);
}

/**
 * UTC instant of the December solstice of `year` (southern summer) —
 * computed, never hardcoded to the 21st: it drifts Dec 20-22.
 */
export function summerSolstice(year: number): Date {
  return solsticeUtc(year, 12);
}

/**
 * UTC instant of the June solstice of `year` (southern winter) —
 * computed the same way: it drifts Jun 20-22.
 */
export function winterSolstice(year: number): Date {
  return solsticeUtc(year, 6);
}

/** Today's date at the given Argentina local time, in UTC. */
export function today(hour = 12, minute = 0): Date {
  const now = new Date();
  const local = new Date(now.getTime() + ARGENTINA_UTC_OFFSET_MS);
  return argentinaLocalToUtc(
    local.getUTCFullYear(),
    local.getUTCMonth() + 1,
    local.getUTCDate(),
    hour,
    minute,
  );
}

export interface SunriseSunset {
  /** UTC instant of sunrise (upper limb at the horizon, with refraction). */
  readonly sunrise: Date;
  readonly sunset: Date;
}

/**
 * Apparent sunrise/sunset UTC instants for the UTC date containing `day`
 * at (latDeg, lonDeg) — the NOAA 90.833° zenith convention (upper limb,
 * with refraction), matching sunrise-sunset.org's "sunrise"/"sunset"
 * fields. Returns undefined for polar day/night, when the sun never
 * crosses the horizon (not reachable inside Jujuy, kept for safety).
 */
export function sunriseSunset(
  day: Date,
  latDeg: number,
  lonDeg: number,
): SunriseSunset | undefined {
  const noon = new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12),
  );
  const { eqTimeMinutes, declinationRad } =
    equationOfTimeAndDeclination(noon);
  const lat = latDeg * DEG;
  const decl = declinationRad;
  const cosH =
    Math.cos(90.833 * DEG) / (Math.cos(lat) * Math.cos(decl)) -
    Math.tan(lat) * Math.tan(decl);
  if (cosH > 1 || cosH < -1) return undefined;
  const haDeg = Math.acos(cosH) / DEG;
  const midnightUtc = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
  );
  const sunriseMinutes = 720 - 4 * (lonDeg + haDeg) - eqTimeMinutes;
  const sunsetMinutes = 720 - 4 * (lonDeg - haDeg) - eqTimeMinutes;
  return {
    sunrise: new Date(midnightUtc + sunriseMinutes * 60_000),
    sunset: new Date(midnightUtc + sunsetMinutes * 60_000),
  };
}

// ---------------------------------------------------------------- colors

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function lerp3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/**
 * Direct sunlight color (tint and intensity together) as a pure function
 * of the apparent sun elevation: neutral white high in the sky, warm
 * orange-red near the horizon, zero once the sun is set. The terrain
 * shader multiplies this by max(dot(N,L),0) * shadowVisibility.
 */
export function sunColor(
  elevationDeg: number,
): readonly [number, number, number] {
  const strength = smoothstep(-1, 5, elevationDeg);
  // Warmth fades in below ~35° and saturates at the horizon.
  const warmth = 1 - smoothstep(-1, 35, elevationDeg);
  const warm: readonly [number, number, number] = [1.0, 0.38, 0.1];
  const white: readonly [number, number, number] = [1, 1, 1];
  const tint = lerp3(warm, white, 1 - warmth);
  return [tint[0] * strength, tint[1] * strength, tint[2] * strength];
}

/**
 * Ambient (sky) light color by sun elevation: a neutral grey matching the
 * app's long-standing ambient level by day, fading to a dim blue at
 * night (sun below −6° — end of civil twilight).
 */
export function skyAmbientColor(
  elevationDeg: number,
): readonly [number, number, number] {
  const dayFactor = smoothstep(-6, 4, elevationDeg);
  const night: readonly [number, number, number] = [0.05, 0.08, 0.15];
  const day: readonly [number, number, number] = [0.42, 0.42, 0.44];
  return lerp3(night, day, dayFactor);
}

/**
 * Multiplicative tint for the diorama sky gradient: neutral by day,
 * warm near the horizon at low sun, dim and bluish at night.
 */
export function skyTintColor(
  elevationDeg: number,
): readonly [number, number, number] {
  const warmth = 1 - smoothstep(-2, 28, elevationDeg);
  const warm: readonly [number, number, number] = [1.0, 0.68, 0.42];
  const dayMix = lerp3([1, 1, 1], warm, warmth * 0.8);
  const night: readonly [number, number, number] = [0.12, 0.16, 0.28];
  const dayFactor = smoothstep(-8, -1, elevationDeg);
  return lerp3(night, dayMix, dayFactor);
}

/**
 * Everything the render layers need for one instant, bundled:
 * sun direction + colors. `lightStrength`/`ambient` scale the neutral
 * components so callers keep their existing brightness knobs.
 */
export interface SunLook {
  /** Unit vector TO the sun, world space (X east, Y up, Z south). */
  readonly direction: readonly [number, number, number];
  /** Direct light color, scaled by `lightStrength`. */
  readonly sunColor: readonly [number, number, number];
  /** Ambient light color, scaled by `ambient` / 0.42. */
  readonly ambientColor: readonly [number, number, number];
  /** Multiplicative tint for the sky gradient. */
  readonly skyTint: readonly [number, number, number];
  readonly elevationDeg: number;
  readonly azimuthDeg: number;
}

export function sunLook(
  utc: Date,
  latDeg: number,
  lonDeg: number,
  opts: { readonly lightStrength?: number; readonly ambient?: number } = {},
): SunLook {
  const pos = solarPosition(utc, latDeg, lonDeg);
  const lightStrength = opts.lightStrength ?? 0.85;
  const ambientScale = (opts.ambient ?? 0.42) / 0.42;
  return {
    direction: sunDirectionWorld(pos.azimuthDeg, pos.elevationDeg),
    sunColor: sunColor(pos.elevationDeg).map(
      (c) => c * lightStrength,
    ) as [number, number, number],
    ambientColor: skyAmbientColor(pos.elevationDeg).map(
      (c) => c * ambientScale,
    ) as [number, number, number],
    skyTint: skyTintColor(pos.elevationDeg),
    elevationDeg: pos.elevationDeg,
    azimuthDeg: pos.azimuthDeg,
  };
}
