/**
 * Pure vector-to-raster helpers for the data pipeline: GeoJSON geometry
 * normalization, scanline fill of polygons (MultiPolygons and holes
 * supported) onto a GridSpec, majority downsampling of the department
 * index and bounding-box helpers. All grids are row-major, j indexes rows
 * southward, i indexes columns eastward — same convention as src/geo.
 */
import { lonLatToGrid, type GridSpec } from "../geo/grid";

export type LonLat = readonly [number, number];
/** A closed GeoJSON linear ring: the last point repeats the first. */
export type LinearRing = readonly LonLat[];
/** A GeoJSON polygon: first ring is the exterior, the rest are holes. */
export type PolygonRings = readonly LinearRing[];

export interface GeoJsonGeometry {
  readonly type: string;
  readonly coordinates: unknown;
}

export interface GeoJsonFeature {
  readonly type: "Feature";
  readonly properties: Record<string, unknown> | null;
  readonly geometry: GeoJsonGeometry;
}

/** [west, south, east, north] in degrees. */
export type BBoxLonLat = readonly [number, number, number, number];
/** Inclusive cell bounds [minI, minJ, maxI, maxJ] on a grid. */
export type BBoxGrid = readonly [number, number, number, number];

/**
 * The 16 departments of Jujuy, taken from the brief — a VALIDATION
 * CHECKLIST, not data. It is only used (after normalizeDepartmentName)
 * to assert that the geoBoundaries source yields exactly the 16
 * expected departments: each feature's shapeName must normalize to one
 * of these names, and all 16 must be found. The names published to
 * departments.json and the app are the source's shapeName verbatim
 * ("Yaví", not the "Yavi" written here).
 */
export const JUJUY_DEPARTMENT_NAMES: readonly string[] = [
  "Yavi",
  "Santa Catalina",
  "Rinconada",
  "Cochinoca",
  "Susques",
  "Humahuaca",
  "Tilcara",
  "Tumbaya",
  "Dr. Manuel Belgrano",
  "Palpalá",
  "El Carmen",
  "San Antonio",
  "Ledesma",
  "San Pedro",
  "Santa Bárbara",
  "Valle Grande",
];

/**
 * Accent- and punctuation-insensitive name key: NFD, strip combining
 * marks, lowercase, keep only [a-z0-9] ("Dr. Manuel Belgrano" →
 * "drmanuelbelgrano", "Yaví" → "yavi").
 */
export function normalizeDepartmentName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function asLonLat(value: unknown, context: string): LonLat {
  if (
    Array.isArray(value) &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  ) {
    return [value[0], value[1]];
  }
  throw new Error(`${context}: expected a [lon, lat] position`);
}

function asRing(value: unknown, context: string): LinearRing {
  if (!Array.isArray(value) || value.length < 4) {
    throw new Error(`${context}: a linear ring needs at least 4 positions`);
  }
  return value.map((p) => asLonLat(p, context));
}

function asPolygon(value: unknown, context: string): PolygonRings {
  if (!Array.isArray(value) || value.length < 1) {
    throw new Error(`${context}: a polygon needs at least one ring`);
  }
  return value.map((r) => asRing(r, context));
}

/**
 * Normalize a GeoJSON Polygon or MultiPolygon to a list of polygons.
 * Throws on any other geometry type or on malformed coordinates.
 */
export function geometryToPolygons(
  geometry: GeoJsonGeometry,
): readonly PolygonRings[] {
  if (geometry.type === "Polygon") {
    return [asPolygon(geometry.coordinates, "Polygon")];
  }
  if (geometry.type === "MultiPolygon") {
    const coords = geometry.coordinates;
    if (!Array.isArray(coords) || coords.length < 1) {
      throw new Error("MultiPolygon: needs at least one polygon");
    }
    return coords.map((p, k) => asPolygon(p, `MultiPolygon[${k}]`));
  }
  throw new Error(`unsupported geometry type "${geometry.type}"`);
}

/** Union bounding box of a set of polygons, [west, south, east, north]. */
export function polygonsBBox(polygons: readonly PolygonRings[]): BBoxLonLat {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const poly of polygons) {
    for (const ring of poly) {
      for (const [lon, lat] of ring) {
        if (lon < west) west = lon;
        if (lon > east) east = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
      }
    }
  }
  if (west === Infinity) {
    throw new Error("polygonsBBox: empty polygon set has no extent");
  }
  return [west, south, east, north];
}

/** Union bounding box over several departments' polygon sets. */
export function unionBBox(
  polygonSets: readonly (readonly PolygonRings[])[],
): BBoxLonLat {
  const boxes = polygonSets.map(polygonsBBox);
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}

/** Mean of every vertex — a cheap inside/outside discriminator. */
export function vertexCentroid(
  polygons: readonly PolygonRings[],
): readonly [number, number] {
  let n = 0;
  let lon = 0;
  let lat = 0;
  for (const poly of polygons) {
    for (const ring of poly) {
      for (const [x, y] of ring) {
        lon += x;
        lat += y;
        n++;
      }
    }
  }
  if (n === 0) {
    throw new Error("vertexCentroid: polygon set has no vertices");
  }
  return [lon / n, lat / n];
}

export function bboxContainsPoint(
  bbox: BBoxLonLat,
  lon: number,
  lat: number,
): boolean {
  return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

/** Convert a ring's lon/lat vertices to fractional grid coordinates. */
function ringToGridCoords(spec: GridSpec, ring: LinearRing): Float64Array {
  const out = new Float64Array(ring.length * 2);
  for (let k = 0; k < ring.length; k++) {
    const [lon, lat] = ring[k] ?? [0, 0];
    const [i, j] = lonLatToGrid(spec, lon, lat);
    out[k * 2] = i;
    out[k * 2 + 1] = j;
  }
  return out;
}

/**
 * Even-odd scanline fill of one polygon (all its rings at once, so holes
 * subtract). Tests cell centers: a cell is filled when its center is inside
 * the polygon. Edges use the half-open convention (a cell center exactly on
 * a shared border goes to the polygon on its east side) so adjacent
 * departments partition the raster without gaps or double fills.
 *
 * Writes `value` into `out`; caller decides what happens on overlaps by
 * ordering the calls.
 */
export function fillPolygon(
  spec: GridSpec,
  polygon: PolygonRings,
  value: number,
  out: Uint8Array,
): void {
  const { width, height } = spec;
  if (out.length !== width * height) {
    throw new Error(
      `fillPolygon: output length ${out.length} != ${width}x${height}`,
    );
  }
  if (value < 0 || value > 255) {
    throw new Error(`fillPolygon: value ${value} does not fit in Uint8`);
  }
  const rings = polygon.map((r) => ringToGridCoords(spec, r));

  // Row range that can contain a cell center: ceil(minY) .. floor(maxY).
  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (let k = 1; k < ring.length; k += 2) {
      const y = ring[k] ?? 0;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const jStart = Math.max(0, Math.ceil(minY));
  const jEnd = Math.min(height - 1, Math.floor(maxY));

  const xs: number[] = [];
  for (let j = jStart; j <= jEnd; j++) {
    xs.length = 0;
    for (const ring of rings) {
      const points = ring.length / 2;
      for (let p = 0; p < points; p++) {
        const x1 = ring[p * 2] ?? 0;
        const y1 = ring[p * 2 + 1] ?? 0;
        const q = p + 1 < points ? p + 1 : 0; // close the ring if needed
        const x2 = ring[q * 2] ?? 0;
        const y2 = ring[q * 2 + 1] ?? 0;
        if ((y1 <= j && j < y2) || (y2 <= j && j < y1)) {
          xs.push(x1 + ((j - y1) * (x2 - x1)) / (y2 - y1));
        }
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const iStart = Math.max(0, Math.ceil(xs[k] ?? 0));
      const iEnd = Math.min(width - 1, Math.ceil(xs[k + 1] ?? 0) - 1);
      const row = j * width;
      for (let i = iStart; i <= iEnd; i++) out[row + i] = value;
    }
  }
}

/**
 * Rasterize every department's polygon set onto the grid: output cell =
 * 0 outside the province, or 1 + position of the department in
 * `departmentPolygons`. Later departments overwrite earlier ones on
 * overlaps (source data should not overlap).
 */
export function rasterizeDepartments(
  spec: GridSpec,
  departmentPolygons: readonly (readonly PolygonRings[])[],
  out = new Uint8Array(spec.width * spec.height),
): Uint8Array {
  if (departmentPolygons.length === 0 || departmentPolygons.length > 255) {
    throw new Error(
      `rasterizeDepartments: expected 1..255 departments, got ${departmentPolygons.length}`,
    );
  }
  departmentPolygons.forEach((polygons, d) => {
    for (const polygon of polygons) {
      fillPolygon(spec, polygon, d + 1, out);
    }
  });
  return out;
}

/**
 * Plurality downsample of an index raster: each output cell takes the most
 * frequent value inside its `factor`x`factor` source block. Ties prefer a
 * nonzero (inside-province) value so thin departments do not erode away,
 * then the lowest index — deterministic either way.
 */
export function majorityDownsampleIndex(
  src: Uint8Array,
  width: number,
  height: number,
  factor: number,
): { data: Uint8Array; width: number; height: number } {
  if (src.length !== width * height) {
    throw new Error(
      `majorityDownsampleIndex: source length ${src.length} != ${width}x${height}`,
    );
  }
  if (!Number.isInteger(factor) || factor < 1) {
    throw new Error(
      `majorityDownsampleIndex: factor must be an integer >= 1, got ${factor}`,
    );
  }
  const outW = Math.ceil(width / factor);
  const outH = Math.ceil(height / factor);
  const data = new Uint8Array(outW * outH);
  const counts = new Uint32Array(256);
  for (let j = 0; j < outH; j++) {
    const j0 = j * factor;
    const j1 = Math.min(j0 + factor, height);
    for (let i = 0; i < outW; i++) {
      const i0 = i * factor;
      const i1 = Math.min(i0 + factor, width);
      counts.fill(0);
      for (let jj = j0; jj < j1; jj++) {
        for (let ii = i0; ii < i1; ii++) {
          const v = src[jj * width + ii] ?? 0;
          counts[v] = (counts[v] ?? 0) + 1;
        }
      }
      let best = 0;
      for (let v = 1; v < counts.length; v++) {
        const cv = counts[v] ?? 0;
        const cb = counts[best] ?? 0;
        // Higher count wins; on a tie a nonzero value beats "outside"
        // (only relevant while best is still 0).
        if (cv > cb || (cv === cb && cv > 0 && best === 0)) best = v;
      }
      data[j * outW + i] = best;
    }
  }
  return { data, width: outW, height: outH };
}

/**
 * Inclusive cell bounds [minI, minJ, maxI, maxJ] of the cells whose value
 * is nonzero. Returns undefined when the raster is entirely zero.
 */
export function nonzeroCellBounds(
  data: ArrayLike<number>,
  width: number,
  height: number,
): BBoxGrid | undefined {
  if (data.length !== width * height) {
    throw new Error(
      `nonzeroCellBounds: data length ${data.length} != ${width}x${height}`,
    );
  }
  let minI = width;
  let minJ = height;
  let maxI = -1;
  let maxJ = -1;
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      if ((data[j * width + i] ?? 0) !== 0) {
        if (i < minI) minI = i;
        if (i > maxI) maxI = i;
        if (j < minJ) minJ = j;
        if (j > maxJ) maxJ = j;
      }
    }
  }
  if (maxI < 0) return undefined;
  return [minI, minJ, maxI, maxJ];
}
