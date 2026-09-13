import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { positions } from '@/db/schema/positions';
import { withTenant } from '@/db/tenant';
import { BusinessDate, FakeClock } from '@/core/shared/clock';
import {
  ConsentId,
  OpportunityRuleId,
  PositionId,
  TransactionId,
  UserId,
  type AssetId,
} from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { ok } from '@/core/shared/result';
import { FakeHeldAssetsPort, FakeQuoteProvider } from '@/core/quotes/test-support';
import { FakeOpportunityNotifier } from '@/core/opportunity/test-support';
import { B3TradingCalendar } from '@/adapters/calendar/b3-calendar';
import { DrizzleConsentRepository } from '@/adapters/db/consent-repository';
import { DrizzleOpportunityRuleRepository } from '@/adapters/db/opportunity-rule-repository';
import { DrizzleValuationSnapshotRepository } from '@/adapters/db/valuation-snapshot-repository';
import { runCatchUp, type CatchUpDeps } from '@/worker/catch-up';
import { handleQuotesPoll } from '@/worker/handlers/quotes';
import {
  handleOpportunityEvaluate,
  type OpportunityEvaluateJobPayload,
} from '@/worker/handlers/opportunity';
import { handleValuationSnapshot } from '@/worker/handlers/valuation';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import {
  resetConfigState,
  resetConsents,
  resetLedger,
  resetOpportunity,
  resetUsers,
} from '../support/reset';
import { seedUser } from '../support/users';
import { seedAsset } from '../support/ledger-fixtures';

/**
 * SPEC-021 — missed-schedule catch-up, end to end against real Postgres.
 *
 * Real: the B3 calendar, every repository, the held-asset walk over
 * `positions`, the budget counter, the gap table, the snapshot rebuild and the
 * opportunity evaluation. Faked: the clock and the quote provider (TS-26 — no
 * live network).
 *
 * **The scenario.** The worker last captured closes on Wednesday 11 March
 * 2026 and comes back on Tuesday 17 March at 11:00 in São Paulo, with the
 * session open. Thursday 12, Friday 13 and Monday 16 were missed — three
 * business days across a weekend (AC: "three business days down").
 *
 *   Ledger (bought Tue 10 March):  PETR4 100 @ 30,00   VALE3 10 @ 60,00
 *
 *   Provider history      Thu 12    Fri 13    Mon 16
 *   PETR4                 31,10     29,00     32,40
 *   VALE3                 61,00     —         62,50     (Friday not supplied)
 *
 * PETR4's Friday close of 29,00 crosses the user's opportunity rule (buy below
 * 30,00). That is the recovered crossing BR-021-33 says must stay silent.
 *
 * **One pool per handler call**, for the reason
 * `tests/integration/opportunity-worker-handler.test.ts` documents at length:
 * a pooled connection that has run `withTenant` breaks a later bare
 * `resolveConfig` on the same connection. That defect is pre-existing and not
 * this file's to fix.
 *
 * TS-03/TS-34: truncates in `beforeAll`, `beforeEach` and `afterAll` — every
 * row this file writes to a shared table (`assets`, `price_quotes`,
 * `price_quote_gaps`, `latest_quotes`, `quote_budget_usage`) is global.
 */
describe('SPEC-021 worker-start catch-up (integration)', () => {
  let testDb: TestDatabase;
  let migratorPool: Pool;
  let seedPool: Pool;
  let seedDb: ReturnType<typeof drizzle<typeof schema>>;

  const userId = UserId.generate();
  let petr: AssetId;
  let vale: AssetId;

  const calendar = new B3TradingCalendar();
  const d = (value: string): BusinessDate => BusinessDate.of(value);
  // Tue 17 March 2026, 11:00 in São Paulo (UTC−3): the session is open.
  const NOW = '2026-03-17T14:00:00Z';

  async function cleanup(): Promise<void> {
    await resetOpportunity(testDb.migrationUrl);
    await resetConsents(testDb.migrationUrl);
    await resetConfigState(testDb.migrationUrl);
    await migratorPool.query(
      'TRUNCATE daily_valuation_snapshots, quote_budget_usage, index_series, price_quote_gaps, price_quotes, latest_quotes RESTART IDENTITY CASCADE',
    );
    await resetLedger(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
  }

  /** A fresh pool, ended when `fn` settles. */
  async function withFreshDb<T>(
    fn: (database: ReturnType<typeof drizzle<typeof schema>>) => Promise<T>,
  ): Promise<T> {
    const pool = new Pool({ connectionString: testDb.appUrl, max: 4 });
    try {
      return await fn(drizzle(pool, { schema }));
    } finally {
      await pool.end();
    }
  }

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    migratorPool = new Pool({ connectionString: testDb.migrationUrl, max: 1 });
    seedPool = new Pool({ connectionString: testDb.appUrl, max: 4 });
    seedDb = drizzle(seedPool, { schema });
    await cleanup();
  }, 180_000);

  afterAll(async () => {
    await cleanup();
    await seedPool.end();
    await migratorPool.end();
    await testDb.stop();
  });

  beforeEach(async () => {
    await cleanup();
    await seedUser(testDb.migrationUrl, userId);
    petr = (await seedAsset(testDb.migrationUrl, 'PETR4', 'Petrobras PN')).id;
    vale = (await seedAsset(testDb.migrationUrl, 'VALE3', 'Vale ON')).id;

    await seedBuy(petr, '100', '30');
    await seedBuy(vale, '10', '60');

    // Wednesday 11 March — the last close `quotes.close-capture` recorded.
    await seedClose(petr, '2026-03-11', '30.50');
    await seedClose(vale, '2026-03-11', '60.00');

    await seedRule();
    await grantEmailConsent();
  });

  async function seedBuy(assetId: AssetId, quantity: string, unitPrice: string): Promise<void> {
    const q = Quantity.fromString(quantity);
    const price = Money.fromString(unitPrice);
    const total = price.times(q);
    await migratorPool.query(
      `INSERT INTO transactions (id, user_id, asset_id, institution_id, type, status,
         trade_date, quantity, unit_price, fees, total_value, ratio, natural_key,
         occurrence, import_batch_id, is_manual, is_user_modified, created_at, updated_at)
       VALUES ($1,$2,$3,NULL,'buy','active','2026-03-10',$4,$5,'0',$6,NULL,$7,1,NULL,true,false,now(),now())`,
      [
        TransactionId.generate(),
        userId,
        assetId,
        q.toString(),
        price.toString(),
        total.toString(),
        `2026-03-10|${assetId}|buy|${quantity}|${unitPrice}`,
      ],
    );
    await withTenant(
      userId,
      (tx) =>
        tx.insert(positions).values({
          id: PositionId.generate(),
          userId,
          assetId,
          institutionId: null,
          quantity: q,
          averageCost: price,
          totalCost: total,
          realizedGain: Money.zero(),
        }),
      seedDb,
    );
  }

  async function seedClose(assetId: AssetId, date: string, close: string): Promise<void> {
    await migratorPool.query(
      `INSERT INTO price_quotes (asset_id, date, close, source) VALUES ($1, $2, $3, 'brapi_free')`,
      [assetId, date, close],
    );
  }

  async function seedRule(): Promise<void> {
    await withTenant(
      userId,
      (tx) =>
        new DrizzleOpportunityRuleRepository(tx, userId).insert({
          id: OpportunityRuleId.generate(),
          userId,
          assetId: petr,
          lower: { price: Money.fromString('30'), state: 'buy' },
          upper: { price: Money.fromString('45'), state: 'sell' },
          defaultState: 'hold',
          // The baseline an evaluation on Wednesday's 30,50 established.
          lastState: 'hold',
          lastEvaluatedAt: new Date('2026-03-11T19:00:00Z'),
          active: true,
          muted: false,
        }),
      seedDb,
    );
  }

  async function grantEmailConsent(): Promise<void> {
    await withTenant(
      userId,
      (tx) =>
        new DrizzleConsentRepository(tx, userId).upsert({
          id: ConsentId.generate(),
          userId,
          purpose: 'email_reminders',
          grantedAt: new Date('2026-01-01T00:00:00Z'),
          revokedAt: null,
          policyVersion: 'v1',
        }),
      seedDb,
    );
  }

  function historyFor(ticker: string, closes: Record<string, string>) {
    return (from: BusinessDate, to: BusinessDate) =>
      ok({
        ticker,
        source: 'brapi_free',
        closes: Object.entries(closes)
          .filter(([date]) => date >= from && date <= to)
          .map(([date, close]) => ({ date: d(date), close: Money.fromString(close) })),
      });
  }

  function scenarioProvider(): FakeQuoteProvider {
    const provider = new FakeQuoteProvider();
    provider.setHistory(
      'PETR4',
      historyFor('PETR4', { '2026-03-12': '31.10', '2026-03-13': '29.00', '2026-03-16': '32.40' }),
    );
    provider.setHistory('VALE3', historyFor('VALE3', { '2026-03-12': '61.00', '2026-03-16': '62.50' }));
    return provider;
  }

  /**
   * The production rebuild (`handleValuationSnapshot({ from })`), with the
   * snapshot repository wrapped only to record the order dates are written in.
   */
  async function catchUp(
    provider: FakeQuoteProvider,
    upserted: string[] = [],
    extra: Partial<CatchUpDeps> = {},
  ) {
    const clock = new FakeClock(NOW);
    return withFreshDb((database) =>
      runCatchUp({
        database,
        clock,
        calendar,
        provider,
        syncMarketSeries: async () => {},
        rebuildSnapshotsFrom: async (from) => {
          const summary = await handleValuationSnapshot(
            { from },
            {
              database,
              clock,
              calendar,
              snapshotsFor: (tx, tenant) => {
                const real = new DrizzleValuationSnapshotRepository(tx, tenant);
                return {
                  upsertMany: async (snapshots) => {
                    upserted.push(...snapshots.map((snapshot) => snapshot.date));
                    await real.upsertMany(snapshots);
                  },
                  deleteFrom: (date) => real.deleteFrom(date),
                  listRange: (a, b) => real.listRange(a, b),
                };
              },
            },
          );
          expect(summary.failures).toBe(0);
        },
        ...extra,
      }),
    );
  }

  it('AC: three business days down → all three closes backfilled and their snapshots written in date order', async () => {
    const provider = scenarioProvider();
    const upserted: string[] = [];

    const summary = await catchUp(provider, upserted);

    expect(summary.days).toEqual(['2026-03-12', '2026-03-13', '2026-03-16']);
    // One request per asset for the whole window (BR-021-32), not one per day.
    expect(summary.requests).toBe(2);
    expect(summary.recovered).toBe(5);
    expect(summary.gaps).toBe(1);
    expect(summary.rebuiltFrom).toBe('2026-03-12');

    const { rows: closes } = await migratorPool.query<{ code: string; date: string; close: string }>(
      `SELECT a.code, q.date::text AS date, q.close::text AS close
         FROM price_quotes q JOIN assets a ON a.id = q.asset_id
        ORDER BY a.code, q.date`,
    );
    expect(closes).toEqual([
      { code: 'PETR4', date: '2026-03-11', close: '30.50000000' },
      { code: 'PETR4', date: '2026-03-12', close: '31.10000000' },
      { code: 'PETR4', date: '2026-03-13', close: '29.00000000' },
      { code: 'PETR4', date: '2026-03-16', close: '32.40000000' },
      { code: 'VALE3', date: '2026-03-11', close: '60.00000000' },
      { code: 'VALE3', date: '2026-03-12', close: '61.00000000' },
      // No 2026-03-13 row for VALE3 — see the gap test below.
      { code: 'VALE3', date: '2026-03-16', close: '62.50000000' },
    ]);

    // BR-021-30: rebuilt from the first missed day through today, ascending.
    expect(upserted).toEqual([
      '2026-03-12',
      '2026-03-13',
      '2026-03-14',
      '2026-03-15',
      '2026-03-16',
      '2026-03-17',
    ]);

    /*
     * Hand-computed totals (quantity × close):
     *   Thu 12   100 × 31,10 = 3.110,00   10 × 61,00 = 610,00   → 3.720,00
     *   Fri 13   100 × 29,00 = 2.900,00   10 × 61,00 = 610,00   → 3.510,00
     *            (VALE3's Friday is a gap; SPEC-009 BR-009-03 carries Thursday's
     *             61,00 forward, flagged. Interpolating would have given
     *             10 × (61,00 + 62,50) / 2 = 617,50 → 3.517,50.)
     *   Sat 14, Sun 15 — no session; Friday's closes carry forward → 3.510,00
     *   Mon 16   100 × 32,40 = 3.240,00   10 × 62,50 = 625,00   → 3.865,00
     *   Tue 17   today, no intraday quote stored → Monday's closes → 3.865,00
     */
    const { rows: snapshots } = await migratorPool.query<{ date: string; total: string }>(
      `SELECT date::text AS date, total_value::text AS total
         FROM daily_valuation_snapshots WHERE user_id = $1 ORDER BY date`,
      [userId],
    );
    expect(snapshots).toEqual([
      { date: '2026-03-12', total: '3720.00000000' },
      { date: '2026-03-13', total: '3510.00000000' },
      { date: '2026-03-14', total: '3510.00000000' },
      { date: '2026-03-15', total: '3510.00000000' },
      { date: '2026-03-16', total: '3865.00000000' },
      { date: '2026-03-17', total: '3865.00000000' },
    ]);

    const { rows: usage } = await migratorPool.query<{ kind: string; count: number }>(
      'SELECT kind, count FROM quote_budget_usage WHERE year_month = $1',
      ['2026-03'],
    );
    expect(usage).toEqual([{ kind: 'scheduled', count: 2 }]);
  });

  it('BR-021-31: a close the provider cannot supply is recorded as a gap, with no stand-in price', async () => {
    await catchUp(scenarioProvider());

    const { rows: gaps } = await migratorPool.query<{ code: string; date: string; reason: string }>(
      `SELECT a.code, g.date::text AS date, g.reason
         FROM price_quote_gaps g JOIN assets a ON a.id = g.asset_id`,
    );
    expect(gaps).toEqual([{ code: 'VALE3', date: '2026-03-13', reason: 'not_supplied' }]);

    const { rows: stand } = await migratorPool.query(
      `SELECT 1 FROM price_quotes WHERE asset_id = $1 AND date = '2026-03-13'`,
      [vale],
    );
    expect(stand).toEqual([]);
  });

  it('BR-021-32: days the budget cannot cover become gaps', async () => {
    // quota 15.000, reserve 10 % → scheduled share floor(15.000 × 90 / 100) = 13.500.
    // Usage 13.499: PETR4 (first by code) fits; VALE3 then finds 13.500 < 13.500 false.
    await migratorPool.query(
      `INSERT INTO quote_budget_usage (year_month, kind, count) VALUES ('2026-03', 'scheduled', 13499)`,
    );
    const provider = scenarioProvider();

    const summary = await catchUp(provider);

    expect(provider.historicalCalls.map((call) => call.ticker)).toEqual(['PETR4']);
    expect(summary.requests).toBe(1);
    const { rows: gaps } = await migratorPool.query<{ date: string; reason: string }>(
      `SELECT date::text AS date, reason FROM price_quote_gaps WHERE asset_id = $1 ORDER BY date`,
      [vale],
    );
    expect(gaps).toEqual([
      { date: '2026-03-12', reason: 'budget_exhausted' },
      { date: '2026-03-13', reason: 'budget_exhausted' },
      { date: '2026-03-16', reason: 'budget_exhausted' },
    ]);
  });

  it('AR-19: a second start in a row finds nothing missed and spends nothing', async () => {
    await catchUp(scenarioProvider());
    const again = scenarioProvider();

    const summary = await catchUp(again);

    expect(summary.days).toEqual([]);
    expect(again.callCount).toBe(0);
  });

  it('AC/BR-021-33: catch-up sends no opportunity email for recovered days; a live crossing afterwards sends exactly one', async () => {
    const provider = scenarioProvider();
    // The live quote the first poll after start will receive: 29,50, below 30,00.
    provider.set('PETR4', () =>
      ok({
        ticker: 'PETR4',
        price: Money.fromString('29.50'),
        quotedAt: new Date(NOW),
        source: 'brapi_free',
      }),
    );
    provider.set('VALE3', () =>
      ok({
        ticker: 'VALE3',
        price: Money.fromString('62.00'),
        quotedAt: new Date(NOW),
        source: 'brapi_free',
      }),
    );

    await catchUp(provider);

    // Friday's recovered 29,00 crossed the rule — and nothing noticed, by construction:
    expect(provider.liveCallCount).toBe(0);
    const { rows: latest } = await migratorPool.query('SELECT 1 FROM latest_quotes');
    expect(latest).toEqual([]);
    const { rows: sentAfterCatchUp } = await migratorPool.query(
      'SELECT 1 FROM opportunity_notifications',
    );
    expect(sentAfterCatchUp).toEqual([]);

    // The first live poll after start, and the evaluation it enqueues.
    const clock = new FakeClock(NOW);
    const enqueued: OpportunityEvaluateJobPayload[] = [];
    await withFreshDb((database) =>
      handleQuotesPoll({
        database,
        clock,
        calendar,
        provider,
        heldAssets: new FakeHeldAssetsPort([petr, vale]),
        enqueueOpportunityEvaluation: async (payload) => {
          enqueued.push(payload);
        },
      }),
    );
    expect(enqueued).toHaveLength(1);

    const notifier = new FakeOpportunityNotifier();
    await withFreshDb((database) =>
      handleOpportunityEvaluate(enqueued[0] as OpportunityEvaluateJobPayload, {
        database,
        clock,
        calendar,
        notifier,
      }),
    );

    // Exactly one. Had catch-up evaluated Friday's 29,00, the rule would
    // already stand at `buy` and this live crossing would send nothing — so
    // one email here is also the proof that catch-up claimed no transition.
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]?.userId).toBe(userId);
    expect(notifier.sent[0]?.alert.state).toBe('buy');
  });
});
