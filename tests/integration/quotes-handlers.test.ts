import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '@/db/schema';
import { BusinessDate, FakeClock } from '@/core/shared/clock';
import { Money } from '@/core/shared/money';
import { ok } from '@/core/shared/result';
import { DrizzleAssetCatalogRepository } from '@/adapters/db/asset-catalog-repository';
import { DrizzleQuoteRepository } from '@/adapters/db/quote-repository';
import { DrizzleQuoteBudgetCounter } from '@/adapters/db/quote-budget-counter';
import { DrizzleCloseGapRepository } from '@/adapters/db/close-gap-repository';
import {
  FakeHeldAssetsPort,
  FakeOfficialCloseSource,
  FakeQuoteProvider,
  FakeTradingCalendar,
} from '@/core/quotes/test-support';
import { handleQuotesCloseCapture, handleQuotesPoll } from '@/worker/handlers/quotes';
import type { OpportunityEvaluateJobPayload } from '@/worker/handlers/opportunity';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetConfigState } from '../support/reset';

/**
 * SPEC-008 handler-level integration: real Postgres for the catalog/quote
 * repository/budget counter (AR-06/AR-07's NUMERIC round-trip and the
 * shared-table writes actually happening), a controllable `FakeClock` /
 * `FakeTradingCalendar` / `FakeHeldAssetsPort` / `FakeQuoteProvider` for
 * everything time- and network-dependent (TS-26 — no live provider).
 */
describe('SPEC-008 quotes.poll / quotes.close-capture handlers (integration)', () => {
  let database: TestDatabase;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.migrationUrl);
    // TS-03: `handleQuotesPoll` resolves `quotes.cadence_minutes` through the
    // config layer, and deployment-level overrides are global to the database.
    // On a reused database another file's leftover row decides this file's
    // result, so clear the layer before trusting it.
    await resetConfigState(database.migrationUrl);
    pool = new Pool({ connectionString: database.appUrl, max: 1 });
    db = drizzle(pool, { schema });
  }, 180_000);

  afterAll(async () => {
    // TS-34, the half this file was missing. `index_series`, `price_quotes`,
    // `latest_quotes`, `assets` and `quote_budget_usage` are global rows with
    // no tenant to scope them — truncating only in `beforeEach` protects this
    // file from its predecessors but leaves its own rows for whatever runs
    // next. A stray CDI point surviving into another file's period compounds
    // into that file's benchmark line and turns an exact figure into a
    // plausible wrong one, which is the failure TS-33/TS-34 exist to catch.
    const migratorPool = new Pool({ connectionString: database.migrationUrl, max: 1 });
    try {
      await migratorPool.query(
        'TRUNCATE quote_budget_usage, index_series, price_quote_gaps, price_quotes, latest_quotes, assets RESTART IDENTITY CASCADE',
      );
    } finally {
      await migratorPool.end();
    }
    await pool.end();
    await database.stop();
  });

  beforeEach(async () => {
    const migratorPool = new Pool({ connectionString: database.migrationUrl, max: 1 });
    try {
      await migratorPool.query(
        'TRUNCATE quote_budget_usage, index_series, price_quote_gaps, price_quotes, latest_quotes, assets RESTART IDENTITY CASCADE',
      );
    } finally {
      await migratorPool.end();
    }
  });

  async function seedHeldAsset(ticker: string): Promise<{ id: string }> {
    const catalog = new DrizzleAssetCatalogRepository(db);
    const asset = await catalog.upsertByCode({ code: ticker, name: ticker, assetClass: 'stock' });
    return { id: asset.id };
  }

  it('BR-008-06: zero provider requests over a simulated weekend', async () => {
    await seedHeldAsset('PETR4');
    const heldAssets = new FakeHeldAssetsPort();
    const catalog = new DrizzleAssetCatalogRepository(db);
    const asset = await catalog.findByCode('PETR4');
    if (!asset) throw new Error('setup failed');
    heldAssets.set([asset.id]);

    const calendar = new FakeTradingCalendar(['2026-03-16']); // only Monday is a trading day
    const provider = new FakeQuoteProvider();
    provider.set('PETR4', () =>
      ok({
        ticker: 'PETR4',
        price: Money.fromString('38.00'),
        quotedAt: new Date(),
        source: 'brapi_free',
      }),
    );

    // Saturday and Sunday — outside the (only) trading day declared above.
    for (const instant of ['2026-03-14T14:00:00Z', '2026-03-15T14:00:00Z']) {
      await handleQuotesPoll({
        database: db,
        clock: new FakeClock(instant),
        calendar,
        catalog,
        repository: new DrizzleQuoteRepository(db),
        budgetCounter: new DrizzleQuoteBudgetCounter(db),
        heldAssets,
        provider,
      });
    }

    expect(provider.callCount).toBe(0);
  });

  it('during an open session, held assets are polled and persisted', async () => {
    await seedHeldAsset('PETR4');
    const catalog = new DrizzleAssetCatalogRepository(db);
    const asset = await catalog.findByCode('PETR4');
    if (!asset) throw new Error('setup failed');
    const heldAssets = new FakeHeldAssetsPort([asset.id]);

    const calendar = new FakeTradingCalendar(['2026-03-16']);
    calendar.sessionOpenOverride = true;
    const provider = new FakeQuoteProvider();
    provider.set('PETR4', () =>
      ok({
        ticker: 'PETR4',
        price: Money.fromString('38.42'),
        quotedAt: new Date(),
        source: 'brapi_free',
      }),
    );
    const repository = new DrizzleQuoteRepository(db);
    const enqueuedEvaluations: OpportunityEvaluateJobPayload[] = [];

    await handleQuotesPoll({
      database: db,
      clock: new FakeClock('2026-03-16T14:00:00Z'),
      calendar,
      catalog,
      repository,
      budgetCounter: new DrizzleQuoteBudgetCounter(db),
      heldAssets,
      provider,
      enqueueOpportunityEvaluation: async (payload) => {
        enqueuedEvaluations.push(payload);
      },
    });

    const stored = await repository.getLatestQuote(asset.id);
    expect(stored?.price.toString()).toBe('38.42');
    expect(provider.callCount).toBe(1);

    // SPEC-018 BR-018-11 — a real poll enqueues evaluation for exactly the
    // asset that just received a new quote.
    expect(enqueuedEvaluations).toEqual([{ assetIds: [asset.id] }]);
  });

  it('SPEC-018 BR-018-11: no opportunity evaluation is enqueued when nothing was polled', async () => {
    await seedHeldAsset('PETR4');
    const catalog = new DrizzleAssetCatalogRepository(db);
    const asset = await catalog.findByCode('PETR4');
    if (!asset) throw new Error('setup failed');
    const heldAssets = new FakeHeldAssetsPort([asset.id]);

    // Session closed — `computePollingSet`/`pollHeldAsset` never run, so
    // there is nothing new to evaluate.
    const calendar = new FakeTradingCalendar(['2026-03-16']);
    const provider = new FakeQuoteProvider();
    const enqueuedEvaluations: OpportunityEvaluateJobPayload[] = [];

    await handleQuotesPoll({
      database: db,
      clock: new FakeClock('2026-03-14T14:00:00Z'), // a Saturday
      calendar,
      catalog,
      repository: new DrizzleQuoteRepository(db),
      budgetCounter: new DrizzleQuoteBudgetCounter(db),
      heldAssets,
      provider,
      enqueueOpportunityEvaluation: async (payload) => {
        enqueuedEvaluations.push(payload);
      },
    });

    expect(enqueuedEvaluations).toEqual([]);
  });

  /**
   * SPEC-008 BR-008-09/BR-008-10/BR-008-30/BR-008-31, DL-008-08, DL-008-14
   * (#171) — official closes come from B3's COTAHIST, never from the quote
   * provider. `quotes.close_capture_time` defaults to 22:00 São Paulo (01:00Z
   * the next day) — `now` below is chosen just after that instant, on the
   * trading day the `FakeTradingCalendar` declares, so the window (computed
   * the same way as catch-up's) is exactly that one day.
   */
  const NOW_AFTER_DEFAULT_CAPTURE_TIME = '2026-03-17T01:05:00Z'; // 2026-03-16T22:05:00-03:00

  it('BR-008-09/10/30/31: close-capture writes B3’s COTAHIST close, supersedes a stored brapi_free close, and never rewrites latest_quotes', async () => {
    await seedHeldAsset('PETR4');
    const catalog = new DrizzleAssetCatalogRepository(db);
    const asset = await catalog.findByCode('PETR4');
    if (!asset) throw new Error('setup failed');
    const heldAssets = new FakeHeldAssetsPort([asset.id]);
    const repository = new DrizzleQuoteRepository(db);

    // An intraday quote AND a stale brapi_free "close" both land first.
    await repository.upsertLatestQuote({
      assetId: asset.id,
      price: Money.fromString('38.00'),
      quotedAt: new Date('2026-03-16T16:55:00Z'),
      fetchedAt: new Date('2026-03-16T16:55:00Z'),
      source: 'brapi_free',
    });
    await repository.upsertClosePrice({
      assetId: asset.id,
      date: BusinessDate.of('2026-03-16'),
      close: Money.fromString('38.10'),
      source: 'brapi_free',
    });

    const calendar = new FakeTradingCalendar(['2026-03-16']);
    const provider = new FakeQuoteProvider(); // never asked — asserted below
    const closeSource = new FakeOfficialCloseSource();
    closeSource.seedDay(BusinessDate.of('2026-03-16'), [
      { ticker: 'PETR4', date: BusinessDate.of('2026-03-16'), close: Money.fromString('38.55') },
    ]);
    const rebuilds: BusinessDate[] = [];

    await handleQuotesCloseCapture({
      database: db,
      clock: new FakeClock(NOW_AFTER_DEFAULT_CAPTURE_TIME),
      calendar,
      catalog,
      repository,
      heldAssets,
      provider,
      closeSource,
      gaps: new DrizzleCloseGapRepository(db),
      unofficial: repository,
      enqueueSnapshotRebuild: async (from) => {
        rebuilds.push(from);
      },
    });

    const close = await repository.getClosePrice(asset.id, BusinessDate.of('2026-03-16'));
    expect(close?.close.toString()).toBe('38.55');
    expect(close?.source).toBe('b3_cotahist');
    // BR-008-10: the earlier intraday quote is untouched — a different table entirely.
    const latest = await repository.getLatestQuote(asset.id);
    expect(latest?.price.toString()).toBe('38'); // decimal.js drops an insignificant trailing zero
    // The close job never reads the quote provider at all.
    expect(provider.callCount).toBe(0);
    // SPEC-009 BR-009-18: the rebuild this write invalidates is enqueued
    // directly from here, from the date that changed.
    expect(rebuilds).toEqual(['2026-03-16']);
  });

  it('a newly held asset with no close ever captured still gets today’s close (BR-008-09, #171)', async () => {
    await seedHeldAsset('VALE3');
    const catalog = new DrizzleAssetCatalogRepository(db);
    const asset = await catalog.findByCode('VALE3');
    if (!asset) throw new Error('setup failed');
    const heldAssets = new FakeHeldAssetsPort([asset.id]);
    const repository = new DrizzleQuoteRepository(db);
    const calendar = new FakeTradingCalendar(['2026-03-16']);
    const closeSource = new FakeOfficialCloseSource();
    closeSource.seedDay(BusinessDate.of('2026-03-16'), [
      { ticker: 'VALE3', date: BusinessDate.of('2026-03-16'), close: Money.fromString('61.20') },
    ]);

    await handleQuotesCloseCapture({
      database: db,
      clock: new FakeClock(NOW_AFTER_DEFAULT_CAPTURE_TIME),
      calendar,
      catalog,
      repository,
      heldAssets,
      provider: new FakeQuoteProvider(),
      closeSource,
      gaps: new DrizzleCloseGapRepository(db),
      unofficial: repository,
      enqueueSnapshotRebuild: async () => {},
    });

    const close = await repository.getClosePrice(asset.id, BusinessDate.of('2026-03-16'));
    expect(close?.close.toString()).toBe('61.2');
  });

  it('AR-19: a retried poll for the same asset within the cadence window makes no second provider call', async () => {
    await seedHeldAsset('PETR4');
    const catalog = new DrizzleAssetCatalogRepository(db);
    const asset = await catalog.findByCode('PETR4');
    if (!asset) throw new Error('setup failed');
    const heldAssets = new FakeHeldAssetsPort([asset.id]);
    const calendar = new FakeTradingCalendar(['2026-03-16']);
    calendar.sessionOpenOverride = true;
    const provider = new FakeQuoteProvider();
    provider.set('PETR4', () =>
      ok({
        ticker: 'PETR4',
        price: Money.fromString('38.42'),
        quotedAt: new Date(),
        source: 'brapi_free',
      }),
    );
    const repository = new DrizzleQuoteRepository(db);
    const budgetCounter = new DrizzleQuoteBudgetCounter(db);
    const clock = new FakeClock('2026-03-16T14:00:00Z');
    const enqueuedEvaluations: OpportunityEvaluateJobPayload[] = [];
    const deps = {
      database: db,
      clock,
      calendar,
      catalog,
      repository,
      budgetCounter,
      heldAssets,
      provider,
      enqueueOpportunityEvaluation: async (payload: OpportunityEvaluateJobPayload) => {
        enqueuedEvaluations.push(payload);
      },
    };

    await handleQuotesPoll(deps);
    await handleQuotesPoll(deps); // simulated pg-boss retry, same instant

    expect(provider.callCount).toBe(1);
    expect((await budgetCounter.getUsage('2026-03')).scheduled).toBe(1);

    /*
     * AR-19 for SPEC-008 is about the *provider*: the retry makes no second
     * call and spends no second request, asserted above.
     *
     * The evaluation enqueue is the opposite requirement, and this assertion
     * is the regression test for getting it wrong. It used to read
     * `toEqual([{ assetIds: [asset.id] }])` — one enqueue, because only
     * freshly *polled* assets were enqueued and the retry polled nothing. But
     * a retry happens precisely when the first attempt failed *after* writing
     * the quote, and the commonest way for it to fail there is the enqueue
     * itself. With the old rule the retry enqueued nothing, and that cycle's
     * quote was never evaluated by anyone — a crossing inside it silently
     * lost, which is the one signal SPEC-018 BR-018-11 depends on.
     *
     * So an already-fresh asset is enqueued too, and the retry re-requests
     * the evaluation. It costs nothing: evaluation issues no provider request
     * by construction and is idempotent over an observation it has already
     * seen (DL-018-08).
     */
    expect(enqueuedEvaluations).toEqual([{ assetIds: [asset.id] }, { assetIds: [asset.id] }]);
  });
});
