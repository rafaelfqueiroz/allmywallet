import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

/**
 * SPEC-020 BR-020-16/19 — a held fixed-income contract whose rate could not
 * be read from the extract, for the "Needs attention" gate and the
 * `/fixed-income/[assetId]` resolution screen it links to.
 *
 * Both are absent on purpose, mirroring SPEC-005 BR-009-13's real cause: the
 * extract carried the position but not enough of the contract's own text to
 * determine either. `core/onboarding` counts this contract only when the
 * asset is currently **held** (`positions.quantity > 0`), which is why this
 * seeds a position alongside the contract rather than the contract alone.
 */
export async function seedHeldFixedIncomeWithMissingRate(
  userId: string,
  code: string,
): Promise<{ readonly assetId: string; readonly code: string }> {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_MIGRATION_URL ??
      'postgresql://allmywallet_migrator:allmywallet@localhost:5432/allmywallet',
    max: 1,
  });
  const assetId = randomUUID();
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  const fullCode = `${code}${suffix}`;

  try {
    await pool.query(`INSERT INTO assets (id, code, name, class) VALUES ($1, $2, $3, 'cdb')`, [
      assetId,
      fullCode,
      `CDB ${fullCode}`,
    ]);
    await pool.query(
      `INSERT INTO positions (id, user_id, asset_id, quantity, average_cost, total_cost, realized_gain)
       VALUES ($1, $2, $3, '1000', '1', '1000', 0)`,
      [randomUUID(), userId, assetId],
    );
    // `indexer` and `rate` both NULL — BR-009-13's "could not be determined".
    await pool.query(
      `INSERT INTO fixed_income_contracts (id, user_id, asset_id, issue_date)
       VALUES ($1, $2, $3, CURRENT_DATE)`,
      [randomUUID(), userId, assetId],
    );
  } finally {
    await pool.end();
  }

  return { assetId, code: fullCode };
}
