import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '@/db/schema';
import { BusinessDate } from '@/core/shared/clock';
import { Money, Quantity } from '@/core/shared/money';
import { ok, err } from '@/core/shared/result';
import { domainError } from '@/core/shared/domain-error';
import { DrizzleAssetCatalogRepository } from '@/adapters/db/asset-catalog-repository';
import { DrizzleQuoteRepository } from '@/adapters/db/quote-repository';
import { DrizzleIndexSeriesRepository } from '@/adapters/db/index-series-repository';
import { handleTesouroSync } from '@/worker/handlers/tesouro';
import { TesouroErrorCode } from '@/adapters/quotes/tesouro';
import { handleBcbSync } from '@/worker/handlers/bcb';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';

/**
 * SPEC-008 BR-008-12 / AC "Tesouro Transparente and BCB SGS series (12, 433,
 * 11) load daily and backfill history" — against real Postgres, with the
 * network boundary faked (TS-26).
 */
describe('SPEC-008 tesouro.sync / bcb.sync handlers (integration)', () => {
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

  it('onboards a Tesouro title into the catalog on first sight and prices it into price_quotes history', async () => {
    const catalog = new DrizzleAssetCatalogRepository(db);
    const repository = new DrizzleQuoteRepository(db);
    const provider = {
      fetchDailyPrices: async () =>
        ok([
          {
            ticker: 'Tesouro Selic 2029',
            date: BusinessDate.of('2026-03-16'),
            price: Money.fromString('14249.60'),
            source: 'tesouro_transparente',
          },
        ]),
    };

    await handleTesouroSync({ catalog, repository, provider });

    const asset = await catalog.findByCode('Tesouro Selic 2029');
    if (!asset) throw new Error('setup failed: asset not onboarded');
    expect(asset.assetClass).toBe('tesouro_direto');
    const close = await repository.getClosePrice(asset.id, BusinessDate.of('2026-03-16'));
    expect(close?.close.toString()).toBe('14249.6');
    // Tesouro has no intraday quote — never touches latest_quotes.
    expect(await repository.getLatestQuote(asset.id)).toBeNull();
  });

  it('AR-19: re-syncing the same title/date overwrites rather than duplicating the catalog row', async () => {
    const catalog = new DrizzleAssetCatalogRepository(db);
    const repository = new DrizzleQuoteRepository(db);
    const point = {
      ticker: 'Tesouro Selic 2029',
      date: BusinessDate.of('2026-03-16'),
      price: Money.fromString('14249.60'),
      source: 'tesouro_transparente',
    };
    const provider = { fetchDailyPrices: async () => ok([point]) };

    await handleTesouroSync({ catalog, repository, provider });
    await handleTesouroSync({ catalog, repository, provider });

    const rows = await pool.query(`SELECT count(*)::int AS n FROM assets WHERE code = $1`, [
      'Tesouro Selic 2029',
    ]);
    expect(rows.rows[0]?.n).toBe(1);
  });

  it('a failed Tesouro fetch writes nothing', async () => {
    const catalog = new DrizzleAssetCatalogRepository(db);
    const repository = new DrizzleQuoteRepository(db);
    const provider = {
      fetchDailyPrices: async () => err(domainError(TesouroErrorCode.UNAVAILABLE, {})),
    };

    await handleTesouroSync({ catalog, repository, provider });

    expect(await catalog.findByCode('Tesouro Selic 2029')).toBeNull();
  });

  it('backfills from scratch on first load, then fetches only since the latest stored point', async () => {
    const indexSeriesRepository = new DrizzleIndexSeriesRepository(db);
    const seenSince: BusinessDate[] = [];
    const provider = {
      fetchSeries: async (code: 'CDI' | 'IPCA' | 'SELIC' | 'IBOV', since: BusinessDate) => {
        seenSince.push(since);
        if (code !== 'CDI') return ok([]);
        return ok([
          {
            code,
            date: BusinessDate.of('2026-03-16'),
            value: Quantity.fromString('11.65'),
            source: 'bcb_sgs',
          },
        ]);
      },
    };
    const quoteProvider = {
      fetchQuote: async () =>
        ok({
          ticker: '^BVSP',
          price: Money.fromString('130000.00'),
          quotedAt: new Date(),
          source: 'brapi_free',
        }),
    };

    await handleBcbSync({
      clock: {
        now: () => new Date('2026-03-16T21:00:00Z'),
        today: () => BusinessDate.of('2026-03-16'),
      },
      indexSeriesRepository,
      provider,
      quoteProvider,
    });

    expect(await indexSeriesRepository.latestDate('CDI')).toBe('2026-03-16');
    // First run for CDI had nothing stored — backfilled from the far-past default.
    expect(seenSince[0]).toBe('2000-01-01');

    await handleBcbSync({
      clock: {
        now: () => new Date('2026-03-17T21:00:00Z'),
        today: () => BusinessDate.of('2026-03-17'),
      },
      indexSeriesRepository,
      provider,
      quoteProvider,
    });

    // Second run fetches only since the point already stored — not a full re-backfill.
    expect(seenSince[3]).toBe('2026-03-16');

    // IBOV, fetched via QuoteProvider, also lands in index_series.
    const ibovRows = await pool.query(
      `SELECT count(*)::int AS n FROM index_series WHERE code = 'IBOV'`,
    );
    expect(ibovRows.rows[0]?.n).toBeGreaterThan(0);
  });
});
