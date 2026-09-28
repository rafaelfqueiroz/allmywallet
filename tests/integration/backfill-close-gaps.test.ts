import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { BusinessDate } from '@/core/shared/clock';
import type { AssetId } from '@/core/shared/ids';
import { Money } from '@/core/shared/money';
import { FakeOfficialCloseSource } from '@/core/quotes/test-support';
import { DrizzleQuoteRepository } from '@/adapters/db/quote-repository';
import { backfillCloseGaps, buildBackfillCloseGapsDeps } from '@/ops/backfill-close-gaps';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { seedAsset } from '../support/ledger-fixtures';
import { resetLedger } from '../support/reset';

/**
 * #151, rewritten for #171 — `ops.js backfill-gaps` against real Postgres:
 * the gap read, the close writes and the gap clears are the real
 * repositories; `OfficialCloseSource` is faked (TS-26) and the snapshot
 * rebuild is observed rather than run.
 *
 * **The scenario.** VALE3's closes for 12 and 13 March were refused
 * (`provider_unavailable`) by an earlier, since-fixed outage, while PETR4's
 * were captured — so catch-up, which looks forward from the newest capture,
 * never retries them. VALE3's 16 March is `not_supplied`: COTAHIST answered
 * and had no close, and asking again would spend a request on an answer
 * already given (`listRetryableGaps` excludes it).
 *
 * TS-03/TS-34: every table written here is shared, so it is truncated before
 * each test and after the file.
 */
describe('#151 backfill-gaps (integration)', () => {
  let testDb: TestDatabase;
  let migratorPool: Pool;
  let appPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;
  let vale: AssetId;

  const d = (value: string): BusinessDate => BusinessDate.of(value);

  async function cleanup(): Promise<void> {
    await migratorPool.query(
      'TRUNCATE quote_budget_usage, price_quote_gaps, price_quotes, latest_quotes RESTART IDENTITY CASCADE',
    );
    await resetLedger(testDb.migrationUrl);
  }

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    migratorPool = new Pool({ connectionString: testDb.migrationUrl, max: 1 });
    appPool = new Pool({ connectionString: testDb.appUrl, max: 4 });
    appDb = drizzle(appPool, { schema });
  }, 180_000);

  afterAll(async () => {
    await cleanup();
    await appPool.end();
    await migratorPool.end();
    await testDb.stop();
  });

  beforeEach(async () => {
    await cleanup();
    vale = (await seedAsset(testDb.migrationUrl, 'VALE3', 'Vale ON')).id;
    await migratorPool.query(
      `INSERT INTO price_quote_gaps (asset_id, date, reason) VALUES
         ($1, '2026-03-12', 'provider_unavailable'),
         ($1, '2026-03-13', 'provider_unavailable'),
         ($1, '2026-03-16', 'not_supplied')`,
      [vale],
    );
  });

  it('recovers the refused closes, clears their gaps, leaves not_supplied alone and rebuilds from the earliest', async () => {
    const source = new FakeOfficialCloseSource();
    source.seedDay(d('2026-03-12'), [
      { ticker: 'VALE3', date: d('2026-03-12'), close: Money.fromString('61.00') },
    ]);
    source.seedDay(d('2026-03-13'), [
      { ticker: 'VALE3', date: d('2026-03-13'), close: Money.fromString('60.75') },
    ]);
    const rebuilds: BusinessDate[] = [];
    const deps = {
      ...(await buildBackfillCloseGapsDeps(appDb)),
      source,
      currentYear: 2026,
      rebuildSnapshotsFrom: (from: BusinessDate) => {
        rebuilds.push(from);
        return Promise.resolve();
      },
    };

    const summary = await backfillCloseGaps(deps);

    expect(summary).toEqual({
      assets: 1,
      recovered: 2,
      stillMissing: 0,
      requests: 2,
      rebuiltFrom: '2026-03-12',
    });
    expect(rebuilds).toEqual(['2026-03-12']);

    const repository = new DrizzleQuoteRepository(appDb);
    expect((await repository.getClosePrice(vale, d('2026-03-12')))?.close.toString()).toBe('61');
    expect((await repository.getClosePrice(vale, d('2026-03-12')))?.source).toBe('b3_cotahist');
    expect((await repository.getClosePrice(vale, d('2026-03-13')))?.close.toString()).toBe('60.75');
    const { rows } = await migratorPool.query<{ date: string; reason: string }>(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, reason FROM price_quote_gaps ORDER BY date`,
    );
    // The two recovered gaps are cleared (by `upsertClosePrice`'s own
    // transaction); the not_supplied gap, never retried, stands.
    expect(rows).toEqual([{ date: '2026-03-16', reason: 'not_supplied' }]);

    // AR-19: a second run finds nothing left to retry and spends nothing.
    const again = await backfillCloseGaps(deps);
    expect(again.requests).toBe(0);
    expect(source.dayCalls).toHaveLength(2);
  });
});
