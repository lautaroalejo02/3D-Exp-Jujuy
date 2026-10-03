/**
 * Pure selection logic for the Jujuy boundaries extract: from the
 * geoBoundaries gbOpen Argentina ADM2 collection, pick the 16 Jujuy
 * departments and check that they form a single connected province. No
 * I/O — scripts/verify-boundaries.ts feeds it the downloaded features
 * and the DEM extent.
 *
 * Selection rule (recorded in the extract's `provenance`): a feature is
 * a Jujuy department when its normalized shapeName matches one of the 16
 * expected names AND the mean of its vertices falls inside the DEM grid
 * extent. The centroid test disambiguates names that also exist in other
 * provinces (the file has three "San Pedro" and two "San Antonio").
 *
 * The script asserts (a) exactly 16 features are selected, one per
 * expected name, and (b) their union is contiguous — every department
 * shares a boundary vertex within ADJACENCY_TOLERANCE_DEG of another, so
 * the province is a single connected component.
 */
import {
  bboxContainsPoint,
  geometryToPolygons,
  JUJUY_DEPARTMENT_NAMES,
  normalizeDepartmentName,
  vertexCentroid,
  type BBoxLonLat,
  type GeoJsonFeature,
  type PolygonRings,
} from "./raster-vector";

/**
 * Two departments count as sharing a boundary when they have vertices
 * closer than this, in degrees (~110 m at 23°S). Shared borders in the
 * source carry coincident vertices; the tolerance only absorbs tiny
 * representation gaps.
 */
export const ADJACENCY_TOLERANCE_DEG = 0.001;

export interface Adm2Feature {
  readonly feature: GeoJsonFeature;
  /** shapeName verbatim from the source — this is the published name. */
  readonly sourceName: string;
  /** normalizeDepartmentName(sourceName); used for matching and sorting. */
  readonly nameKey: string;
  readonly polygons: readonly PolygonRings[];
  readonly centroid: readonly [number, number];
}

/**
 * Picks the Jujuy departments out of an ADM2 feature collection: every
 * expected name (compared normalized) must match exactly one feature
 * whose vertex centroid falls inside `demExtent`. Throws with the list
 * of problems when the selection is not exactly the 16 departments.
 */
export function selectJujuyDepartments(
  features: readonly GeoJsonFeature[],
  demExtent: BBoxLonLat,
): Adm2Feature[] {
  // The brief's list is a checklist only: every expected name (compared
  // normalized) must match exactly one feature inside the DEM extent.
  const expectedByKey = new Map(
    JUJUY_DEPARTMENT_NAMES.map((n) => [normalizeDepartmentName(n), n]),
  );
  const candidates: Adm2Feature[] = [];
  for (const feature of features) {
    const sourceName = feature.properties?.shapeName;
    if (typeof sourceName !== "string") continue;
    const nameKey = normalizeDepartmentName(sourceName);
    if (!expectedByKey.has(nameKey)) continue;
    const polygons = geometryToPolygons(feature.geometry);
    const centroid = vertexCentroid(polygons);
    if (!bboxContainsPoint(demExtent, centroid[0], centroid[1])) continue;
    candidates.push({ feature, sourceName, nameKey, polygons, centroid });
  }

  // Exactly one candidate per expected name, 16 total.
  const perKey = new Map<string, Adm2Feature[]>();
  for (const c of candidates) {
    const list = perKey.get(c.nameKey) ?? [];
    list.push(c);
    perKey.set(c.nameKey, list);
  }
  const problems: string[] = [];
  for (const [key, expected] of expectedByKey) {
    const found = perKey.get(key) ?? [];
    if (found.length === 0) problems.push(`missing department "${expected}"`);
    if (found.length > 1) {
      problems.push(
        `"${expected}" matched ${found.length} features inside the DEM extent`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(`Jujuy department selection failed:\n  ${problems.join("\n  ")}`);
  }
  // Every expected name matched exactly one feature (checked above), so
  // the candidates are the 16 departments.
  return candidates;
}

/**
 * Union-find over vertex proximity: polygon sets are adjacent when any
 * two of their vertices are within `toleranceDeg`. Returns the number of
 * connected components; the province is valid only at exactly 1.
 */
export function connectedComponents(
  polygonSets: readonly (readonly PolygonRings[])[],
  toleranceDeg: number = ADJACENCY_TOLERANCE_DEG,
): number {
  const parent = polygonSets.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] ?? r;
    let cur = i;
    while (parent[cur] !== r) {
      const next = parent[cur] ?? cur;
      parent[cur] = r;
      cur = next;
    }
    return r;
  };

  const tol = toleranceDeg;
  const cells = new Map<string, { f: number; x: number; y: number }[]>();
  polygonSets.forEach((polygons, f) => {
    for (const poly of polygons) {
      for (const ring of poly) {
        for (const [x, y] of ring) {
          const key = `${Math.floor(x / tol)},${Math.floor(y / tol)}`;
          const list = cells.get(key) ?? [];
          list.push({ f, x, y });
          cells.set(key, list);
        }
      }
    }
  });
  polygonSets.forEach((polygons, f) => {
    for (const poly of polygons) {
      for (const ring of poly) {
        for (const [x, y] of ring) {
          const cx = Math.floor(x / tol);
          const cy = Math.floor(y / tol);
          for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
              for (const o of cells.get(`${cx + dx},${cy + dy}`) ?? []) {
                if (o.f === f) continue;
                if (Math.hypot(o.x - x, o.y - y) <= tol) {
                  const ra = find(f);
                  const rb = find(o.f);
                  if (ra !== rb) parent[ra] = rb;
                }
              }
            }
          }
        }
      }
    }
  });
  return new Set(polygonSets.map((_, i) => find(i))).size;
}
