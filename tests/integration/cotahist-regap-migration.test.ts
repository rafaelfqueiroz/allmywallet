import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger } from '../support/reset';

/**
 * Migration `0031_cotahist_regap.sql` (#171). Every `not_supplied` gap on a
 * listed asset was brapi's answer; COTAHIST is asked again for each, once, by
 * relabelling it retryable. A Tesouro gap is Tesouro Transparente's answer and
 * stands. Assets and dates are invented (DV-24).
 */
describe('migration 0031 — brapi-era gaps become retryable (integration)', () => {
  let database: TestDatabase;
  let migratorPool: Pool;

  const migration = async () =>
    migratorPool.query(
      await readFile(join(process.cwd(), 'src/db/migrations/0031_cotahist_regap.sql'), 'utf8'),
    );

  const addAsset = async (code: string, assetClass: string): Promise<string> => {
    const id = randomUUID();
    await migratorPool.query('INSERT INTO assets (id, code, name, class) VALUES ($1, $2, $2, $3)', [
      id,
      code,
      assetClass,
    ]);
    return id;
  };

  const addGap = async (assetId: string, date: string, reason: string) =>
    migratorPool.query(
      'INSERT INTO price_quote_gaps (asset_id, date, reason) VALUES ($1, $2, $3)',
      [assetId, date, reason],
    );

  const gaps = async () =>
    (
      await migratorPool.query(
        `SELECT a.code, to_char(g.date, 'YYYY-MM-DD') AS date, g.reason
           FROM price_quote_gaps g JOIN assets a ON a.id = g.asset_id
          ORDER BY a.code, g.date`,
      )
    ).rows as { code: string; date: string; reason: string }[];

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.migrationUrl);
    migratorPool = new Pool({ connectionString: database.migrationUrl, max: 2 });
  }, 180_000);

  afterAll(async () => {
    // TS-34: `assets` cascades to both market tables this file writes.
    await resetLedger(database.migrationUrl);
    await migratorPool.end();
    await database.stop();
  });

  beforeEach(async () => {
    await resetLedger(database.migrationUrl);
  });

  it('relabels listed-asset not_supplied gaps retryable, and leaves every other gap alone', async () => {
    const stock = await addAsset('XPTO3', 'stock');
    const fii = await addAsset('XPTO11', 'fii');
    const tesouro = await addAsset('Tesouro Selic 2031', 'tesouro_direto');
    await addGap(stock, '2026-08-20', 'not_supplied');
    await addGap(stock, '2026-08-21', 'budget_exhausted');
    await addGap(fii, '2026-08-20', 'not_supplied');
    await addGap(fii, '2026-08-21', 'provider_unavailable');
    await addGap(tesouro, '2026-08-20', 'not_supplied');

    await migration();

    expect(await gaps()).toEqual([
      { code: 'Tesouro Selic 2031', date: '2026-08-20', reason: 'not_supplied' },
      { code: 'XPTO11', date: '2026-08-20', reason: 'provider_unavailable' },
      { code: 'XPTO11', date: '2026-08-21', reason: 'provider_unavailable' },
      { code: 'XPTO3', date: '2026-08-20', reason: 'provider_unavailable' },
      { code: 'XPTO3', date: '2026-08-21', reason: 'budget_exhausted' },
    ]);

    // Idempotent: a second application changes nothing.
    const before = await gaps();
    await migration();
    expect(await gaps()).toEqual(before);
  });
});
