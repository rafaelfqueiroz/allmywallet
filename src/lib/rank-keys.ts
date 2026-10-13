/**
 * SPEC-022 BR-022-18 / SPEC-015 BR-015-02 — each row's position in one
 * column's ascending order, or `undefined` where that row has no figure.
 *
 * A **rank** is a property of a column, not of a cell: it is only known once
 * every row's figure has been compared with every other, so it is computed for
 * the whole column on the server, with the exact `comparedTo` of `Money` or
 * `Quantity`. What crosses to a Client Component is an integer — never the
 * figure — so a table can sort a money column numerically without a `number`
 * ever standing in for an amount (AR-06–AR-10), and a masked column still
 * sorts: an order is not an amount (BR-022-24).
 *
 * Ties keep their input order (`Array.prototype.sort` is stable), so two equal
 * rows do not swap places when the table is sorted by another column and back.
 * An absent figure gets no rank rather than a low one: `sortUndefined: 'last'`
 * keeps it at the bottom in both directions, which "no figure" is owed — it is
 * not the smallest value. Neutral on purpose (imports nothing, structural
 * `comparedTo`), so the Portfólio, Configurações and Relatórios pages share it;
 * decimal arithmetic stays out of `src/app/` (AR-35).
 */
export function ranksOf<T, F extends { comparedTo(other: never): number }>(
  items: readonly T[],
  pick: (item: T) => F | null | undefined,
): readonly (number | undefined)[] {
  const present = items
    .map((item, index) => ({ index, figure: pick(item) }))
    .filter(
      (entry): entry is { index: number; figure: F } =>
        entry.figure !== null && entry.figure !== undefined,
    )
    .sort((a, b) => a.figure.comparedTo(b.figure as never));

  const ranks: (number | undefined)[] = items.map(() => undefined);
  present.forEach((entry, rank) => {
    ranks[entry.index] = rank;
  });
  return ranks;
}

/**
 * One row's sort keys from the columns' ranks: a column where the row has no
 * figure is simply absent, which the table sorts last in both directions.
 */
export function rankKeys(
  columns: Readonly<Record<string, readonly (number | undefined)[]>>,
  index: number,
): Record<string, number> {
  const keys: Record<string, number> = {};
  for (const [column, ranks] of Object.entries(columns)) {
    const rank = ranks[index];
    if (rank !== undefined) keys[column] = rank;
  }
  return keys;
}
