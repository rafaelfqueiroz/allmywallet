/**
 * The largest number of rows any single `INSERT ... VALUES` here carries.
 *
 * Not a tuning knob — a correctness bound. Drizzle builds one statement by
 * recursively merging a `SQL` fragment per row, and at ten thousand rows that
 * recursion overflows the JS call stack before Postgres is ever asked
 * anything: `RangeError: Maximum call stack size exceeded` inside
 * `mergeQueries`. Postgres's own 65.535-parameter ceiling sits behind that and
 * would be the next wall.
 *
 * Both walls are reachable on the same path. SPEC-005's acceptance criterion
 * is "an import of **10.000 rows** previews in under 30s", and staging writes
 * one `import_rows` row per extract line, so the largest import the spec names
 * is precisely the one that could not complete. It was never measured until
 * `tests/performance/import-budget.test.ts` existed to measure it.
 *
 * 500 keeps the widest table here (17 columns) at ~8.500 bindings — an order
 * of magnitude under the parameter ceiling, and shallow enough that the
 * recursion is never in question.
 */
export const INSERT_CHUNK_SIZE = 500;

/** Splits `rows` into runs of at most `size`, preserving order. */
export function chunked<T>(rows: readonly T[], size: number = INSERT_CHUNK_SIZE): readonly T[][] {
  if (rows.length <= size) return rows.length === 0 ? [] : [[...rows]];
  const chunks: T[][] = [];
  for (let start = 0; start < rows.length; start += size) {
    chunks.push([...rows.slice(start, start + size)]);
  }
  return chunks;
}
