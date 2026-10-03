import type { Place } from "../../terrain/places-manifest";

/**
 * Fly-to camera distance for a place, in km. Tapping a place should land
 * on a framing that still shows context — not a ground-texture closeup.
 *
 * Heuristic (documented per the S1b task): places whose Wikidata
 * `instanceOf` labels name a large geographic feature — lakes, salt
 * flats, parks, mountain ranges, valleys/canions — get ~40 km; towns and
 * point-sized features get ~25 km. `facts.areaKm2` is NOT used: for the
 * municipalities it reports the whole department's area (e.g. San Pedro
 * ~2150 km²), not the feature's footprint, so it would over-zoom cities.
 * Single peaks ("montaña") stay at 25 km: that distance already shows
 * the massif; only ranges ("cordillera") count as large.
 */
export const PLACE_VIEW_DISTANCE_KM = 25;
export const LARGE_PLACE_VIEW_DISTANCE_KM = 40;

/** Wikidata instanceOf labels (Spanish, as stored in places.json). */
const LARGE_FEATURE_INSTANCE_OF: ReadonlySet<string> = new Set([
  "lago",
  "salar",
  "cordillera",
  "cañón",
  "valle",
  "parque nacional",
  "parque nacional de Argentina",
  "parque provincial",
]);

export function placeViewDistanceKm(place: {
  readonly facts: Place["facts"];
}): number {
  const kinds = place.facts?.instanceOf ?? [];
  return kinds.some((kind) => LARGE_FEATURE_INSTANCE_OF.has(kind))
    ? LARGE_PLACE_VIEW_DISTANCE_KM
    : PLACE_VIEW_DISTANCE_KM;
}
