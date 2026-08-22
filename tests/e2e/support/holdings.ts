import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

/**
 * A tenant with real holdings, for the report journeys.
 *
 * ---------------------------------------------------------------------------
 * WHY A REPORT E2E HAS TO SEED
 *
 * The signed-in fixture owns nothing, and a report driven against an empty
 * tenant renders `ReportEmptyState` — so every assertion about a table, a
 * share, a flag or a drill-down passes by never reaching the branch it claims
 * to test. That is not hypothetical: the first CSV-export E2E on this suite
 * passed while exercising nothing, as `reports-scope.spec.ts` records.
 *
 * Written for `composition.spec.ts` and lifted here when the BR-011-07
 * drill-down journey needed the same tenant. One seeder rather than two, for
 * the reason DL-011-02 gives about the framework itself: a second copy is a
 * second definition of "a portfolio", and the weaker one becomes the one new
 * journeys are written against.
 * ---------------------------------------------------------------------------
 */
const MIGRATION_URL =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://allmywallet_migrator:allmywallet@localhost:5432/allmywallet';

export interface SeededHolding {
  readonly code: string;
  readonly quantity: string;
  readonly averageCost: string;
  readonly price: string;
}

/**
 * `assets` is shared reference data with a unique `code`, and the suite runs
 * across two Playwright projects at once — so every code carries a per-run
 * suffix. A fixed code would make the second project's insert fail on the
 * first's row, intermittently, which is the worst way for a suite to be wrong.
 */
export async function seedHoldings(
  userId: string,
  holdings: readonly SeededHolding[],
): Promise<readonly string[]> {
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  const codes: string[] = [];

  try {
    for (const holding of holdings) {
      const assetId = randomUUID();
      const code = `${holding.code}${suffix}`;
      codes.push(code);

      await pool.query(`INSERT INTO assets (id, code, name, class) VALUES ($1, $2, $3, 'stock')`, [
        assetId,
        code,
        `Ativo ${code}`,
      ]);

      const totalCost = String(Number(holding.quantity) * Number(holding.averageCost));
      await pool.query(
        `INSERT INTO positions (id, user_id, asset_id, quantity, average_cost, total_cost, realized_gain)
         VALUES ($1, $2, $3, $4, $5, $6, 0)`,
        [randomUUID(), userId, assetId, holding.quantity, holding.averageCost, totalCost],
      );

      // BR-008-04's two timestamps: the provider's as-of instant and ours.
      await pool.query(
        `INSERT INTO latest_quotes (asset_id, price, quoted_at, fetched_at, source)
         VALUES ($1, $2, now() - interval '30 minutes', now(), 'e2e-seed')`,
        [assetId, holding.price],
      );
      // The close, so a report valued on a non-trading day still prices.
      await pool.query(
        `INSERT INTO price_quotes (asset_id, date, close, source)
         VALUES ($1, CURRENT_DATE, $2, 'e2e-seed')
         ON CONFLICT (asset_id, date) DO NOTHING`,
        [assetId, holding.price],
      );
    }
  } finally {
    await pool.end();
  }

  return codes;
}
