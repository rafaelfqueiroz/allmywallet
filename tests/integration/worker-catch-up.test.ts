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
import { FakeHeldAssetsPort, FakeOfficialCloseSource, FakeQuoteProvider } from '@/core/quotes/test-support';
import { FakeOpportunityNotifier } from '@/core/opportunity/test-support';
import { ok } from '@/core/shared/result';
import { B3TradingCalendar } from '@/adapters/calendar/b3-calendar';
import { DrizzleConsentRepository } from '@/adapters/db/consent-repository';
import { DrizzleOpportunityRuleRepository } from '@/adapters/db/opportunity-rule-repository';
import { DrizzleValuationSnapshotRepository } from '@/adapters/db/valuation-snapshot-repository';
import { runCatchUp, type CatchUpDeps } from '@/worker/catch-up';
import { handleQuotesCloseCapture, handleQuotesPoll } from '@/worker/handlers/quotes';
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
 * SPEC-021 — missed-schedule catch-up, end to end against real Postgres,
 * rewritten onto `syncOfficialCloses` for #171 (SPEC-008 BR-008-09/BR-008-30):
 * every close this recovers is B3's own COTAHIST, never brapi's, and there is
 * no monthly-quota budget to exhaust (BR-021-32 is satisfied vacuously — see
 * `core/quotes/sync-official-closes.ts`'s own comment).
 *
 * Real: the B3 calendar, every repository, the held-asset walk over
 * `positions`, the gap table, the snapshot rebuild and the opportunity
 * evaluation. Faked: the clock, `OfficialCloseSource` and (for the live-poll
 * half of the last test) the intraday quote provider (TS-26 — no live
 * network).
 *
 * **The scenario.** The worker last captured closes on Wednesday 11 March
 * 2026 and comes back on Tuesday 17 March at 11:00 in São Paulo, with the
 * session open. Thursday 12, Friday 13 and Monday 16 were missed — three
 * business days across a weekend (AC: "three business days down").
 *
 *   Ledger (bought Tue 10 March):  PETR4 100 @ 30,00   VALE3 10 @ 60,00
 *
 *   COTAHIST close        Thu 12    Fri 13    Mon 16
 *   PETR4                 31,10     29,00     32,40
 *   VALE3                 61,00     —         62,50     (Friday not supplied)
 *
 * PETR4's Friday close of 29,00 crosses the user's opportunity rule (buy below
 * 30,00). That is the recovered crossing BR-021-33 says must stay silent.
 *
 * **Requests.** `fetchOfficialCloses` reads one COTAHIST daily file per
 * distinct missed day, covering every ticker still wanted that day — not one
 * request per asset the way the pre-#171 provider-history path did. Three
 * missed days both assets need closes for is three requests, not two.
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

    // Wednesday 11 March — the last close on file, already from COTAHIST
    // (the steady state once #171's migration has run).
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
      `INSERT INTO price_quotes (asset_id, date, close, source) VALUES ($1, $2, $3, 'b3_cotahist')`,
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

  /** One COTAHIST daily file per day, with rows for whichever tickers closed that day. */
  function scenarioCloseSource(): FakeOfficialCloseSource {
    const source = new FakeOfficialCloseSource();
    source.seedDay(d('2026-03-12'), [
      { ticker: 'PETR4', date: d('2026-03-12'), close: Money.fromString('31.10') },
      { ticker: 'VALE3', date: d('2026-03-12'), close: Money.fromString('61.00') },
    ]);
    // VALE3 absent from the 13th's file — published, but not supplied for it.
    source.seedDay(d('2026-03-13'), [
      { ticker: 'PETR4', date: d('2026-03-13'), close: Money.fromString('29.00') },
    ]);
    source.seedDay(d('2026-03-16'), [
      { ticker: 'PETR4', date: d('2026-03-16'), close: Money.fromString('32.40') },
      { ticker: 'VALE3', date: d('2026-03-16'), close: Money.fromString('62.50') },
    ]);
    return source;
  }

  /**
   * The production rebuild (`handleValuationSnapshot({ from })`), with the
   * snapshot repository wrapped only to record the order dates are written in.
   */
  async function catchUp(
    closeSource: FakeOfficialCloseSource,
    upserted: string[] = [],
    extra: Partial<CatchUpDeps> = {},
  ) {
    const clock = new FakeClock(NOW);
    return withFreshDb((database) =>
      runCatchUp({
        database,
        clock,
        calendar,
        closeSource,
        syncMarketSeries: async () => [],
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
    const closeSource = scenarioCloseSource();
    const upserted: string[] = [];

    const summary = await catchUp(closeSource, upserted);

    expect(summary.days).toEqual(['2026-03-12', '2026-03-13', '2026-03-16']);
    // One COTAHIST daily file per missed day (BR-008-30), not one per asset.
    expect(summary.requests).toBe(3);
    expect(summary.recovered).toBe(5);
    expect(summary.gaps).toBe(1);
    expect(summary.rebuiltFrom).toBe('2026-03-12');

    const { rows: closes } = await migratorPool.query<{
      code: string;
      date: string;
      close: string;
      source: string;
    }>(
      `SELECT a.code, q.date::text AS date, q.close::text AS close, q.source
         FROM price_quotes q JOIN assets a ON a.id = q.asset_id
        ORDER BY a.code, q.date`,
    );
    expect(closes).toEqual([
      { code: 'PETR4', date: '2026-03-11', close: '30.50000000', source: 'b3_cotahist' },
      { code: 'PETR4', date: '2026-03-12', close: '31.10000000', source: 'b3_cotahist' },
      { code: 'PETR4', date: '2026-03-13', close: '29.00000000', source: 'b3_cotahist' },
      { code: 'PETR4', date: '2026-03-16', close: '32.40000000', source: 'b3_cotahist' },
      { code: 'VALE3', date: '2026-03-11', close: '60.00000000', source: 'b3_cotahist' },
      { code: 'VALE3', date: '2026-03-12', close: '61.00000000', source: 'b3_cotahist' },
      // No 2026-03-13 row for VALE3 — see the gap test below.
      { code: 'VALE3', date: '2026-03-16', close: '62.50000000', source: 'b3_cotahist' },
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
  });

  it('BR-021-31: a close COTAHIST cannot supply is recorded as a gap, with no stand-in price', async () => {
    await catchUp(scenarioCloseSource());

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

  it('a real close later clears a gap row for its day in the same transaction it is written in', async () => {
    // A gap row for Monday, as if an earlier run had found it unpublished then.
    await migratorPool.query(
      `INSERT INTO price_quote_gaps (asset_id, date, reason) VALUES ($1, '2026-03-16', 'not_supplied')`,
      [vale],
    );
    await catchUp(scenarioCloseSource());

    const { rows: gaps } = await migratorPool.query<{ code: string; date: string }>(
      `SELECT a.code, g.date::text AS date FROM price_quote_gaps g JOIN assets a ON a.id = g.asset_id
        ORDER BY a.code, g.date`,
    );
    // Monday's now-real close cleared the stand-in gap; Friday's, which has
    // no close, stands.
    expect(gaps).toEqual([{ code: 'VALE3', date: '2026-03-13' }]);
  });

  /**
   * #169: the window is measured per asset. PETR4 was captured every day while
   * VALE3 was refused, and measuring from the newest close across both would
   * report nothing missed. VALE3's days are recovered; PETR4, already
   * captured, is never even requested (its own close already matches
   * COTAHIST's source, so `syncOfficialCloses`'s window pairs skip it).
   */
  it('#169/BR-021-28: one asset captured and another behind — only the one behind is requested', async () => {
    await seedClose(petr, '2026-03-12', '31.10');
    await seedClose(petr, '2026-03-13', '29.00');
    await seedClose(petr, '2026-03-16', '32.40');
    const closeSource = scenarioCloseSource();

    const summary = await catchUp(closeSource);

    expect(summary.days).toEqual(['2026-03-12', '2026-03-13', '2026-03-16']);
    expect(closeSource.dayCalls).toEqual([
      { date: '2026-03-12', tickers: ['VALE3'] },
      { date: '2026-03-13', tickers: ['VALE3'] },
      { date: '2026-03-16', tickers: ['VALE3'] },
    ]);
    const { rows } = await migratorPool.query<{ date: string; close: string }>(
      `SELECT date::text AS date, close::text AS close FROM price_quotes
        WHERE asset_id = $1 AND date > '2026-03-11' ORDER BY date`,
      [vale],
    );
    expect(rows.map((row) => [row.date, Money.fromString(row.close).toString()])).toEqual([
      ['2026-03-12', '61'],
      ['2026-03-16', '62.5'],
    ]);
    expect(summary.rebuiltFrom).toBe('2026-03-12');
  });

  it('AR-19: a second start in a row finds nothing missed and spends nothing', async () => {
    await catchUp(scenarioCloseSource());
    const again = new FakeOfficialCloseSource();

    const summary = await catchUp(again);

    expect(summary.days).toEqual([]);
    expect(again.dayCalls).toEqual([]);
    expect(again.yearCalls).toEqual([]);
  });

  it('BR-021-28/31: caught up well before the (default 22:00) capture time leaves today to the close job, which then captures it and clears any gap for the day', async () => {
    const closeSource = scenarioCloseSource();
    closeSource.seedDay(d('2026-03-17'), [
      { ticker: 'PETR4', date: d('2026-03-17'), close: Money.fromString('33.10') },
      { ticker: 'VALE3', date: d('2026-03-17'), close: Money.fromString('63.00') },
    ]);
    // A gap row for today, as an earlier, since-fixed run could have left behind.
    await migratorPool.query(
      `INSERT INTO price_quote_gaps (asset_id, date, reason) VALUES ($1, '2026-03-17', 'not_supplied')`,
      [petr],
    );

    // 20:00 São Paulo (23:00Z) — well after the 17:00 session close, well
    // before the default 22:00 capture time, so today is not yet due.
    const summary = await withFreshDb((database) =>
      runCatchUp({
        database,
        clock: new FakeClock('2026-03-17T23:00:00Z'),
        calendar,
        closeSource,
        syncMarketSeries: async () => [],
        rebuildSnapshotsFrom: async () => {},
      }),
    );
    expect(summary.days).toEqual(['2026-03-12', '2026-03-13', '2026-03-16']);
    expect(closeSource.dayCalls.every((c) => c.date <= '2026-03-16')).toBe(true);

    // 22:05 São Paulo (2026-03-18T01:05Z) — the close job runs as scheduled
    // and is not blocked by catch-up having already run.
    await withFreshDb((database) =>
      handleQuotesCloseCapture({
        database,
        clock: new FakeClock('2026-03-18T01:05:00Z'),
        calendar,
        closeSource,
        heldAssets: new FakeHeldAssetsPort([petr, vale]),
      }),
    );

    const { rows: closes } = await migratorPool.query<{ code: string; close: string }>(
      `SELECT a.code, q.close::text AS close FROM price_quotes q JOIN assets a ON a.id = q.asset_id
        WHERE q.date = '2026-03-17' ORDER BY a.code`,
    );
    expect(closes).toEqual([
      { code: 'PETR4', close: '33.10000000' },
      { code: 'VALE3', close: '63.00000000' },
    ]);
    // The close write deleted today's gap in the same transaction; Friday's
    // VALE3 gap, which has no close, stands.
    const { rows: gaps } = await migratorPool.query<{ code: string; date: string }>(
      `SELECT a.code, g.date::text AS date FROM price_quote_gaps g JOIN assets a ON a.id = g.asset_id
        ORDER BY a.code, g.date`,
    );
    expect(gaps).toEqual([{ code: 'VALE3', date: '2026-03-13' }]);
  });

  /**
   * #161: the Tesouro sync runs at 18:30, the equity capture by default at
   * 22:00. A laptop closed in between captures every close and misses every
   * Tesouro day, so catch-up must sync on a start that found no close missing.
   * The sync queues the rebuild for what it fills itself, so catch-up rebuilds
   * nothing of its own here.
   */
  it('#161: a start with no close missed still syncs the market series, and rebuilds nothing itself', async () => {
    await catchUp(scenarioCloseSource());
    let synced = 0;
    const rebuilt: BusinessDate[] = [];

    const summary = await catchUp(new FakeOfficialCloseSource(), [], {
      syncMarketSeries: async () => {
        synced += 1;
        return [];
      },
      rebuildSnapshotsFrom: async (from) => {
        rebuilt.push(from);
      },
    });

    expect(synced).toBe(1);
    expect(rebuilt).toEqual([]);
    expect(summary.rebuiltFrom).toBeNull();
  });

  /** A tenant holding only Tesouro polls nothing, and must still be synced. */
  it('#161: a start with nothing polled still syncs the market series', async () => {
    let synced = 0;

    const summary = await catchUp(scenarioCloseSource(), [], {
      heldAssets: { listDistinctHeldAssetIds: async () => [] },
      syncMarketSeries: async () => {
        synced += 1;
        return [];
      },
    });

    expect(synced).toBe(1);
    expect(summary.days).toEqual([]);
  });

  /** #123, BR-008-27: catch-up has no retry of its own, so it reports what the worker must enqueue. */
  it('#123: a market sync that failed is reported for the worker to hand to its queue', async () => {
    const quiet = await catchUp(scenarioCloseSource(), [], {
      heldAssets: { listDistinctHeldAssetIds: async () => [] },
      syncMarketSeries: async () => ['bcb.sync'],
    });
    expect(quiet.retryQueues).toEqual(['bcb.sync']);

    const recovering = await catchUp(scenarioCloseSource(), [], {
      syncMarketSeries: async () => ['bcb.sync', 'tesouro.sync'],
    });
    expect(recovering.rebuiltFrom).not.toBeNull();
    expect(recovering.retryQueues).toEqual(['bcb.sync', 'tesouro.sync']);
  });

  it('AC/BR-021-33: catch-up sends no opportunity email for recovered days; a live crossing afterwards sends exactly one', async () => {
    const closeSource = scenarioCloseSource();
    await catchUp(closeSource);

    // Friday's recovered 29,00 crossed the rule — and nothing noticed, by construction:
    expect(closeSource.dayCalls.length + closeSource.yearCalls.length).toBeGreaterThan(0);
    const { rows: latest } = await migratorPool.query('SELECT 1 FROM latest_quotes');
    expect(latest).toEqual([]);
    const { rows: sentAfterCatchUp } = await migratorPool.query(
      'SELECT 1 FROM opportunity_notifications',
    );
    expect(sentAfterCatchUp).toEqual([]);

    // The first live poll after start, and the evaluation it enqueues. The
    // intraday quote provider is unrelated to `OfficialCloseSource` — it is
    // what `quotes.poll` (never catch-up) reads from.
    const provider = new FakeQuoteProvider();
    provider.set('PETR4', () =>
      ok({
        ticker: 'PETR4',
        price: Money.fromString('29.50'), // below 30,00
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
