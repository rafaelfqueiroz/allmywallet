import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '@/db/schema';
import { BusinessDate } from '@/core/shared/clock';
import { Money, Quantity } from '@/core/shared/money';
import { DrizzleAssetCatalogRepository } from '@/adapters/db/asset-catalog-repository';
import { DrizzleQuoteRepository } from '@/adapters/db/quote-repository';
import { DrizzleCloseGapRepository } from '@/adapters/db/close-gap-repository';
import { DrizzleIndexSeriesRepository } from '@/adapters/db/index-series-repository';
import { DrizzleQuoteBudgetCounter } from '@/adapters/db/quote-budget-counter';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';

/**
 * TESTING §1: NUMERIC ⇄ Money/Quantity round-tripping and RLS-exemption
 * behaviour cannot be proven against a mock — these adapters are exercised
 * against real Postgres. All four tables are shared/RLS-exempt
 * (BR-008-25 / src/db/shared-tables.ts), so no `withTenant` is involved.
 */
describe('SPEC-008 market data repositories (integration)', () => {
  let database: TestDatabase;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.migrationUrl);
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
        'TRUNCATE quote_budget_usage, index_series, price_quotes, latest_quotes, assets RESTART IDENTITY CASCADE',
      );
    } finally {
      await migratorPool.end();
    }
    await pool.end();
    await database.stop();
  });

  // TS-03: order-agnostic against a reused database — truncate what this
  // file depends on before every test, not just once in beforeAll.
  beforeEach(async () => {
    const migratorPool = new Pool({ connectionString: database.migrationUrl, max: 1 });
    try {
      await migratorPool.query(
        'TRUNCATE quote_budget_usage, index_series, price_quotes, latest_quotes, assets RESTART IDENTITY CASCADE',
      );
    } finally {
      await migratorPool.end();
    }
  });

  describe('DrizzleAssetCatalogRepository', () => {
    it('round-trips a code lookup and findByIds', async () => {
      const repo = new DrizzleAssetCatalogRepository(db);
      const created = await repo.upsertByCode({
        code: 'PETR4',
        name: 'Petrobras PN',
        assetClass: 'stock',
      });

      const byCode = await repo.findByCode('PETR4');
      expect(byCode?.id).toBe(created.id);
      expect(byCode?.assetClass).toBe('stock');

      const byId = await repo.findById(created.id);
      expect(byId?.code).toBe('PETR4');

      const byIds = await repo.findByIds([created.id]);
      expect(byIds).toHaveLength(1);

      expect(await repo.findByCode('NOTATICKER')).toBeNull();
      expect(await repo.findByIds([])).toEqual([]);
    });

    it('AR-19: upsertByCode is idempotent on code — a retried sync updates, never duplicates', async () => {
      const repo = new DrizzleAssetCatalogRepository(db);
      const first = await repo.upsertByCode({
        code: 'Tesouro Selic 2029',
        name: 'Tesouro Selic 2029',
        assetClass: 'tesouro_direto',
      });
      const second = await repo.upsertByCode({
        code: 'Tesouro Selic 2029',
        name: 'Tesouro Selic 2029 (updated)',
        assetClass: 'tesouro_direto',
      });
      expect(second.id).toBe(first.id);
      expect(second.name).toBe('Tesouro Selic 2029 (updated)');
    });
  });

  describe('DrizzleQuoteRepository', () => {
    it('AR-06/AR-07: round-trips Money through latest_quotes and price_quotes without float drift', async () => {
      const catalog = new DrizzleAssetCatalogRepository(db);
      const repo = new DrizzleQuoteRepository(db);
      const asset = await catalog.upsertByCode({
        code: 'VALE3',
        name: 'Vale',
        assetClass: 'stock',
      });

      await repo.upsertLatestQuote({
        assetId: asset.id,
        price: Money.fromString('61.87654321'),
        quotedAt: new Date('2026-03-16T13:30:00Z'),
        fetchedAt: new Date('2026-03-16T14:00:00Z'),
        source: 'brapi_free',
      });
      const latest = await repo.getLatestQuote(asset.id);
      expect(latest?.price.equals(Money.fromString('61.87654321'))).toBe(true);

      await repo.upsertClosePrice({
        assetId: asset.id,
        date: BusinessDate.of('2026-03-16'),
        close: Money.fromString('62.00000001'),
        source: 'brapi_free',
      });
      const close = await repo.getClosePrice(asset.id, BusinessDate.of('2026-03-16'));
      expect(close?.close.equals(Money.fromString('62.00000001'))).toBe(true);

      // BR-008-10: the two tables are independent — a missing PETR4 asset_id
      // on a different date never shows up on this one.
      expect(await repo.getClosePrice(asset.id, BusinessDate.of('2026-03-17'))).toBeNull();
    });

    /**
     * SPEC-005 BR-005-20d (#144) — `ClosePriceReader.closeOnOrBefore`, the
     * commit-time read a resolved subscription is priced from. Same table,
     * same query `getCloseOnOrBefore` already proves for SPEC-009's
     * carry-forward; this is the second name that query answers to.
     */
    it('SPEC-005 BR-005-20d: closeOnOrBefore returns the close on the date, or the nearest earlier one, however old', async () => {
      const catalog = new DrizzleAssetCatalogRepository(db);
      const repo = new DrizzleQuoteRepository(db);
      const asset = await catalog.upsertByCode({
        code: 'XPML11',
        name: 'XP Malls',
        assetClass: 'fii',
      });

      await repo.upsertClosePrice({
        assetId: asset.id,
        date: BusinessDate.of('2024-01-02'),
        close: Money.fromString('100.00'),
        source: 'brapi_free',
      });
      await repo.upsertClosePrice({
        assetId: asset.id,
        date: BusinessDate.of('2024-02-22'),
        close: Money.fromString('114.90'),
        source: 'brapi_free',
      });

      // Exact date.
      const exact = await repo.closeOnOrBefore(asset.id, BusinessDate.of('2024-02-22'));
      expect(exact?.date).toBe('2024-02-22');
      expect(exact?.close.equals(Money.fromString('114.90'))).toBe(true);

      // No close on this date — D2: the nearest earlier one, however old.
      const carried = await repo.closeOnOrBefore(asset.id, BusinessDate.of('2024-06-01'));
      expect(carried?.date).toBe('2024-02-22');
      expect(carried?.close.equals(Money.fromString('114.90'))).toBe(true);

      // Before any close exists at all.
      expect(await repo.closeOnOrBefore(asset.id, BusinessDate.of('2023-12-31'))).toBeNull();
    });

    it('BR-008-09/10: the close upsert never rewrites a different day, and never touches latest_quotes', async () => {
      const catalog = new DrizzleAssetCatalogRepository(db);
      const repo = new DrizzleQuoteRepository(db);
      const asset = await catalog.upsertByCode({
        code: 'ITUB4',
        name: 'Itaú',
        assetClass: 'stock',
      });

      await repo.upsertClosePrice({
        assetId: asset.id,
        date: BusinessDate.of('2026-03-16'),
        close: Money.fromString('30.00'),
        source: 'brapi_free',
      });
      await repo.upsertClosePrice({
        assetId: asset.id,
        date: BusinessDate.of('2026-03-17'),
        close: Money.fromString('31.00'),
        source: 'brapi_free',
      });

      const day1 = await repo.getClosePrice(asset.id, BusinessDate.of('2026-03-16'));
      const day2 = await repo.getClosePrice(asset.id, BusinessDate.of('2026-03-17'));
      expect(day1?.close.toString()).toBe('30');
      expect(day2?.close.toString()).toBe('31');
      expect(await repo.getLatestQuote(asset.id)).toBeNull(); // never written by upsertClosePrice
    });

    /** SPEC-008 BR-008-09/BR-021-31 (#171) — a close COTAHIST no longer supplies must not stay in history. */
    it('deleteClose removes exactly the one (asset, date) row and leaves neighbours untouched', async () => {
      const catalog = new DrizzleAssetCatalogRepository(db);
      const repo = new DrizzleQuoteRepository(db);
      const asset = await catalog.upsertByCode({
        code: 'BBDC4',
        name: 'Bradesco',
        assetClass: 'stock',
      });
      await repo.upsertClosePrice({
        assetId: asset.id,
        date: BusinessDate.of('2026-03-16'),
        close: Money.fromString('14.00'),
        source: 'brapi_free',
      });
      await repo.upsertClosePrice({
        assetId: asset.id,
        date: BusinessDate.of('2026-03-17'),
        close: Money.fromString('14.20'),
        source: 'brapi_free',
      });

      await repo.deleteClose(asset.id, BusinessDate.of('2026-03-16'));

      expect(await repo.getClosePrice(asset.id, BusinessDate.of('2026-03-16'))).toBeNull();
      expect(
        (await repo.getClosePrice(asset.id, BusinessDate.of('2026-03-17')))?.close.toString(),
      ).toBe('14.2');
      // Idempotent (AR-19): deleting an already-absent row is a no-op, not an error.
      await expect(
        repo.deleteClose(asset.id, BusinessDate.of('2026-03-16')),
      ).resolves.toBeUndefined();
    });

    /** SPEC-008 BR-008-09/BR-008-30/BR-008-11 (#171) — `UnofficialClosesPort`, the supersede source. */
    it('listUnofficialListedCloses finds every listed-class close not from officialSource, any date, ignoring fixed income', async () => {
      const catalog = new DrizzleAssetCatalogRepository(db);
      const repo = new DrizzleQuoteRepository(db);
      const stock = await catalog.upsertByCode({
        code: 'ITSA4',
        name: 'Itaúsa',
        assetClass: 'stock',
      });
      const fii = await catalog.upsertByCode({
        code: 'HGLG11',
        name: 'CSHG Log',
        assetClass: 'fii',
      });
      const alreadyOfficial = await catalog.upsertByCode({
        code: 'PETR4',
        name: 'Petrobras',
        assetClass: 'stock',
      });
      const cdb = await catalog.upsertByCode({
        code: 'CDB Banco X',
        name: 'CDB Banco X',
        assetClass: 'cdb',
      });

      await repo.upsertClosePrice({
        assetId: stock.id,
        date: BusinessDate.of('2024-01-15'), // long before any current window
        close: Money.fromString('9.80'),
        source: 'brapi_free',
      });
      await repo.upsertClosePrice({
        assetId: fii.id,
        date: BusinessDate.of('2026-03-16'),
        close: Money.fromString('158.40'),
        source: 'brapi_free',
      });
      await repo.upsertClosePrice({
        assetId: alreadyOfficial.id,
        date: BusinessDate.of('2026-03-16'),
        close: Money.fromString('38.55'),
        source: 'b3_cotahist',
      });
      await repo.upsertClosePrice({
        assetId: cdb.id,
        date: BusinessDate.of('2026-03-16'),
        close: Money.fromString('1.05'),
        source: 'brapi_free', // a fixed-income row COTAHIST never prices
      });

      const unofficial = await repo.listUnofficialListedCloses('b3_cotahist');

      expect(unofficial.map((row) => [row.code, row.date])).toEqual([
        ['HGLG11', '2026-03-16'],
        ['ITSA4', '2024-01-15'],
      ]);
      expect(
        unofficial.every((row) => row.assetId !== alreadyOfficial.id && row.assetId !== cdb.id),
      ).toBe(true);
    });

    /** SPEC-008 BR-008-30 (#171) — the retryable gaps every close run asks COTAHIST for again. */
    it('listRetryableListedGaps finds provider_unavailable and budget_exhausted gaps on listed assets only', async () => {
      const catalog = new DrizzleAssetCatalogRepository(db);
      const repo = new DrizzleQuoteRepository(db);
      const gaps = new DrizzleCloseGapRepository(db);
      const stock = await catalog.upsertByCode({
        code: 'ABEV3',
        name: 'Ambev',
        assetClass: 'stock',
      });
      const etf = await catalog.upsertByCode({ code: 'BOVA11', name: 'BOVA11', assetClass: 'etf' });
      const tesouro = await catalog.upsertByCode({
        code: 'Tesouro Selic 2031',
        name: 'Tesouro Selic 2031',
        assetClass: 'tesouro_direto',
      });
      await gaps.recordGap({
        assetId: stock.id,
        date: BusinessDate.of('2026-01-12'),
        reason: 'provider_unavailable',
      });
      await gaps.recordGap({
        assetId: stock.id,
        date: BusinessDate.of('2026-01-13'),
        reason: 'not_supplied',
      });
      await gaps.recordGap({
        assetId: etf.id,
        date: BusinessDate.of('2026-02-02'),
        reason: 'budget_exhausted',
      });
      await gaps.recordGap({
        assetId: tesouro.id,
        date: BusinessDate.of('2026-01-12'),
        reason: 'provider_unavailable',
      });

      const retryable = await repo.listRetryableListedGaps();

      expect(retryable.map((row) => [row.code, row.date])).toEqual([
        ['ABEV3', '2026-01-12'],
        ['BOVA11', '2026-02-02'],
      ]);
    });
  });

  describe('DrizzleIndexSeriesRepository', () => {
    it('round-trips CDI points and reports the latest date', async () => {
      const repo = new DrizzleIndexSeriesRepository(db);
      await repo.upsertPoints([
        {
          code: 'CDI',
          date: BusinessDate.of('2026-03-14'),
          value: Quantity.fromString('11.65'),
          source: 'bcb_sgs',
        },
        {
          code: 'CDI',
          date: BusinessDate.of('2026-03-16'),
          value: Quantity.fromString('11.70'),
          source: 'bcb_sgs',
        },
      ]);
      expect(await repo.latestDate('CDI')).toBe('2026-03-16');
      expect(await repo.latestDate('IPCA')).toBeNull();
    });

    it('AR-19: re-upserting the same (code, date) overwrites rather than duplicating', async () => {
      const repo = new DrizzleIndexSeriesRepository(db);
      await repo.upsertPoints([
        {
          code: 'SELIC',
          date: BusinessDate.of('2026-03-16'),
          value: Quantity.fromString('10.75'),
          source: 'bcb_sgs',
        },
      ]);
      await repo.upsertPoints([
        {
          code: 'SELIC',
          date: BusinessDate.of('2026-03-16'),
          value: Quantity.fromString('10.80'),
          source: 'bcb_sgs',
        },
      ]);
      expect(await repo.latestDate('SELIC')).toBe('2026-03-16');
    });
  });

  describe('DrizzleQuoteBudgetCounter', () => {
    it('BR-008-19/20: tracks scheduled and on-demand usage independently, atomically', async () => {
      const counter = new DrizzleQuoteBudgetCounter(db);
      expect(await counter.getUsage('2026-03')).toEqual({ scheduled: 0, ondemand: 0 });

      await Promise.all([
        counter.increment('2026-03', 'scheduled'),
        counter.increment('2026-03', 'scheduled'),
        counter.increment('2026-03', 'ondemand'),
      ]);
      // AR-19: the increment is a single atomic SQL statement (count = count +
      // 1), so concurrent increments landing at the same instant cannot lose
      // one to a read-then-write race — asserted here against real Postgres,
      // not a mock that could not exhibit the race in the first place.
      expect(await counter.getUsage('2026-03')).toEqual({ scheduled: 2, ondemand: 1 });
    });

    it('keeps different months independent', async () => {
      const counter = new DrizzleQuoteBudgetCounter(db);
      await counter.increment('2026-02', 'scheduled');
      await counter.increment('2026-03', 'scheduled');
      expect(await counter.getUsage('2026-02')).toEqual({ scheduled: 1, ondemand: 0 });
      expect(await counter.getUsage('2026-03')).toEqual({ scheduled: 1, ondemand: 0 });
    });
  });
});
