/**
 * SPEC-022 BR-022-18 — the server's half of a sortable report table.
 *
 * `ReportTable` receives rendered cells and sorts them by a *rank*, because the
 * figure behind a cell is a `Money` or a `Quantity` that cannot cross to the
 * client (AR-06–AR-10), and decimal arithmetic is not importable under
 * `src/app/` (AR-35). The rank is computed here, with exact `comparedTo`.
 */

/**
 * Each figure's position in the column's ascending order, or `undefined` where
 * the row has no figure.
 *
 * Ties keep their input order, so two equal rows do not swap places when the
 * table is sorted by another column and back. An absent figure gets no rank
 * rather than a low one: `sortUndefined: 'last'` keeps it at the bottom in both
 * directions, which "no figure" is owed — it is not the smallest value.
 */
export function ranksOf<T extends { comparedTo(other: T): number }>(
  figures: readonly (T | null | undefined)[],
): (number | undefined)[] {
  const present = figures
    .map((figure, index) => ({ index, figure }))
    .filter(
      (entry): entry is { index: number; figure: T } =>
        entry.figure !== null && entry.figure !== undefined,
    )
    // `Array.prototype.sort` is stable, which is what keeps the ties in order.
    .sort((a, b) => a.figure.comparedTo(b.figure));

  const ranks: (number | undefined)[] = figures.map(() => undefined);
  present.forEach((entry, rank) => {
    ranks[entry.index] = rank;
  });
  return ranks;
}
