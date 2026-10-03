/**
 * Accent-insensitive place search for the Explorar sheet. Pure — no DOM,
 * no GPU — so the filter is unit-tested and reusable.
 *
 * Names are normalized with NFD + combining-mark removal on both sides,
 * so "yavi" matches "Yaví" and "quebrada" matches "Quebrada".
 */

/** Lowercase, NFD-decomposed, combining-mark-free, trimmed text. */
export function normalizeSearchText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

/**
 * Places whose name contains the query (normalized substring). An empty
 * or whitespace-only query returns every place, in the given order.
 */
export function filterPlacesByName<T extends { readonly name: string }>(
  places: readonly T[],
  query: string,
): T[] {
  const needle = normalizeSearchText(query);
  if (needle === "") return [...places];
  return places.filter((p) =>
    normalizeSearchText(p.name).includes(needle),
  );
}
