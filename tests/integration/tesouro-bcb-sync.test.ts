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
import { TesouroErrorCode, parseTesouroCsv } from '@/adapters/quotes/tesouro';
import { DrizzleAssetResolver } from '@/adapters/db/ingestion-resolvers';
import { handleBcbSync } from '@/worker/handlers/bcb';
import { BcbSgsErrorCode } from '@/adapters/quotes/bcb-sgs';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';

/**
 * SPEC-008 BR-008-12 / AC "Tesouro Transparente and BCB SGS series (12, 433,
 * 11) load daily and backfill history" — against real Postgres, with the
 * network boundary faked (TS-26).
 */
/** The durable rebuild request is asserted where it matters; elsewhere it is not the subject. */
const noRebuild = async (): Promise<void> => {};

const CSV_HEADER =
  'Tipo Titulo;Data Vencimento;Data Base;Taxa Compra Manha;Taxa Venda Manha;PU Compra Manha;PU Venda Manha;PU Base Manha';

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

    await handleTesouroSync({ catalog, repository, provider, enqueueSnapshotRebuild: noRebuild });

    const asset = await catalog.findByCode('Tesouro Selic 2029');
    if (!asset) throw new Error('setup failed: asset not onboarded');
    expect(asset.assetClass).toBe('tesouro_direto');
    const close = await repository.getClosePrice(asset.id, BusinessDate.of('2026-03-16'));
    expect(close?.close.toString()).toBe('14249.6');
    // Tesouro has no intraday quote — never touches latest_quotes.
    expect(await repository.getLatestQuote(asset.id)).toBeNull();
  });

  /**
   * #152: the importer creates the held title under B3's name; the sync must
   * price that asset, not onboard a second one under Tesouro Transparente's
   * product and maturity date that nothing holds.
   */
  it('prices the title the importer created under B3’s name, onboarding no second asset', async () => {
    const catalog = new DrizzleAssetCatalogRepository(db);
    const repository = new DrizzleQuoteRepository(db);
    const heldId = await new DrizzleAssetResolver(db).resolve({
      code: 'Tesouro IPCA+ 2029',
      name: 'Tesouro IPCA+ 2029',
      assetClass: 'tesouro_direto',
      nameStated: true,
      classStated: true,
    });
    const csv = [
      'Tipo Titulo;Data Vencimento;Data Base;Taxa Compra Manha;Taxa Venda Manha;PU Compra Manha;PU Venda Manha;PU Base Manha',
      'Tesouro IPCA+;15/05/2029;16/03/2026;5,79;5,84;3.415,00;3.413,70;3.414,20',
    ].join('\n');
    const points = parseTesouroCsv(csv, 'tesouro_transparente');
    if (points === null) throw new Error('setup failed: fixture CSV did not parse');

    await handleTesouroSync({
      catalog,
      repository,
      provider: { fetchDailyPrices: async () => ok(points) },
      enqueueSnapshotRebuild: noRebuild,
    });

    const close = await repository.getClosePrice(heldId, BusinessDate.of('2026-03-16'));
    expect(close?.close.toString()).toBe('3413.7');
    const { rows } = await pool.query(
      "SELECT code FROM assets WHERE class = 'tesouro_direto' ORDER BY code",
    );
    expect(rows.map((row) => row.code)).toEqual(['Tesouro IPCA+ 2029']);
  });

  /**
   * #164: no B3 extract holding a Renda+ has been seen, so the importer must
   * meet the sync's asset whichever way B3 spells the product.
   */
  it('#164: a Renda+ imported under another spelling is the title the sync prices', async () => {
    const catalog = new DrizzleAssetCatalogRepository(db);
    const repository = new DrizzleQuoteRepository(db);
    const heldId = await new DrizzleAssetResolver(db).resolve({
      code: 'TESOURO RENDA+ 2030',
      name: 'TESOURO RENDA+ 2030',
      assetClass: 'tesouro_direto',
      nameStated: true,
      classStated: true,
    });
    const points = parseTesouroCsv(
      [
        CSV_HEADER,
        'Tesouro Renda+ Aposentadoria Extra;15/12/2049;16/03/2026;6,90;7,02;1.410,00;1.402,55;1.402,55',
      ].join('\n'),
      'tesouro_transparente',
    );
    if (points === null) throw new Error('setup failed: fixture CSV did not parse');

    await handleTesouroSync({
      catalog,
      repository,
      provider: { fetchDailyPrices: async () => ok(points) },
      enqueueSnapshotRebuild: noRebuild,
    });

    const close = await repository.getClosePrice(heldId, BusinessDate.of('2026-03-16'));
    expect(close?.close.toString()).toBe('1402.55');
    const { rows } = await pool.query(
      "SELECT code FROM assets WHERE class = 'tesouro_direto' ORDER BY code",
    );
    expect(rows.map((row) => row.code)).toEqual(['Tesouro Renda+ Aposentadoria Extra 2030']);
  });

  it('AR-19: re-syncing the same title/date keeps one catalog row', async () => {
    const catalog = new DrizzleAssetCatalogRepository(db);
    const repository = new DrizzleQuoteRepository(db);
    const point = {
      ticker: 'Tesouro Selic 2029',
      date: BusinessDate.of('2026-03-16'),
      price: Money.fromString('14249.60'),
      source: 'tesouro_transparente',
    };
    const provider = { fetchDailyPrices: async () => ok([point]) };

    await handleTesouroSync({ catalog, repository, provider, enqueueSnapshotRebuild: noRebuild });
    await handleTesouroSync({ catalog, repository, provider, enqueueSnapshotRebuild: noRebuild });

    const rows = await pool.query(`SELECT count(*)::int AS n FROM assets WHERE code = $1`, [
      'Tesouro Selic 2029',
    ]);
    expect(rows.rows[0]?.n).toBe(1);
  });

  /**
   * #161: the file is every title's whole history, and a run stores whatever
   * of it is missing — so a day an earlier run never saw (21/09 here) is
   * filled by the next one, a stored close is left as it is, and the run
   * queues a snapshot rebuild from the earliest day it filled.
   */
  it('#161: fills every published day not yet stored, keeps what is, and queues the rebuild', async () => {
    const catalog = new DrizzleAssetCatalogRepository(db);
    const repository = new DrizzleQuoteRepository(db);
    const firstRun = parseTesouroCsv(
      [
        CSV_HEADER,
        'Tesouro Selic;01/03/2029;18/09/2026;0,03;0,04;19.890,00;19.885,68;19.885,68',
      ].join('\n'),
      'tesouro_transparente',
    );
    const history = parseTesouroCsv(
      [
        CSV_HEADER,
        'Tesouro Selic;01/03/2029;18/09/2026;0,03;0,04;19.890,00;11.111,11;11.111,11',
        'Tesouro Selic;01/03/2029;21/09/2026;0,03;0,04;19.910,62;19.895,62;19.895,62',
        'Tesouro Selic;01/03/2029;22/09/2026;0,03;0,04;19.920,00;19.905,00;19.905,00',
        // Held until it matured: the whole of its history is a value to show.
        'Tesouro Selic;01/03/2025;14/02/2025;0,03;0,04;15.900,00;15.890,10;15.890,10',
      ].join('\n'),
      'tesouro_transparente',
    );
    if (firstRun === null || history === null) throw new Error('setup failed: fixture CSV');
    const rebuilds: BusinessDate[] = [];
    const sync = (points: typeof history) =>
      handleTesouroSync({
        catalog,
        repository,
        provider: { fetchDailyPrices: async () => ok(points) },
        enqueueSnapshotRebuild: async (from) => {
          rebuilds.push(from);
        },
      });

    await sync(firstRun);
    expect(rebuilds).toEqual(['2026-09-18']);
    const selic = await catalog.findByCode('Tesouro Selic 2029');
    if (!selic) throw new Error('setup failed: title not onboarded');
    // One gap the new close covers, one on a day that still has no close.
    await pool.query(
      `INSERT INTO price_quote_gaps (asset_id, date, reason)
       VALUES ($1, '2026-09-21', 'not_supplied'), ($1, '2026-09-23', 'not_supplied')`,
      [selic.id],
    );

    await sync(history);

    expect(rebuilds).toEqual(['2026-09-18', '2025-02-14']);
    const { rows } = await pool.query(
      `SELECT a.code, to_char(q.date, 'YYYY-MM-DD') AS date, q.close::text AS close
         FROM price_quotes q JOIN assets a ON a.id = q.asset_id ORDER BY a.code, q.date`,
    );
    expect(rows).toEqual([
      { code: 'Tesouro Selic 2025', date: '2025-02-14', close: '15890.10000000' },
      // Stored before: kept, not overwritten by the later file.
      { code: 'Tesouro Selic 2029', date: '2026-09-18', close: '19885.68000000' },
      { code: 'Tesouro Selic 2029', date: '2026-09-21', close: '19895.62000000' },
      { code: 'Tesouro Selic 2029', date: '2026-09-22', close: '19905.00000000' },
    ]);
    const gaps = await pool.query(
      "SELECT to_char(date, 'YYYY-MM-DD') AS date FROM price_quote_gaps WHERE asset_id = $1",
      [selic.id],
    );
    expect(gaps.rows).toEqual([{ date: '2026-09-23' }]);

    // AR-19: nothing left to fill, nothing written, nothing queued.
    await sync(history);
    expect(rebuilds).toHaveLength(2);
  });

  /**
   * The real file is ~176k closes, written in chunks of 2 000. Every chunk must
   * land, and the earliest day must be found whichever chunk holds it.
   */
  it('#161: a history larger than one insert chunk lands whole, earliest day found in a later chunk', async () => {
    const catalog = new DrizzleAssetCatalogRepository(db);
    const repository = new DrizzleQuoteRepository(db);
    const lines = [CSV_HEADER];
    // 2 500 consecutive days, newest first, so the earliest sits in the second chunk.
    for (let day = 2_499; day >= 0; day -= 1) {
      const date = new Date(Date.UTC(2019, 0, 1 + day));
      const br = `${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${date.getUTCFullYear()}`;
      lines.push(`Tesouro Selic;01/03/2029;${br};0,03;0,04;15.000,00;14.999,00;14.999,00`);
    }
    const points = parseTesouroCsv(lines.join('\n'), 'tesouro_transparente');
    if (points === null) throw new Error('setup failed: fixture CSV');
    const rebuilds: BusinessDate[] = [];

    await handleTesouroSync({
      catalog,
      repository,
      provider: { fetchDailyPrices: async () => ok(points) },
      enqueueSnapshotRebuild: async (from) => {
        rebuilds.push(from);
      },
    });

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM price_quotes');
    expect(rows[0]?.n).toBe(2_500);
    expect(rebuilds).toEqual(['2019-01-01']);
  });

  it('a failed Tesouro fetch writes nothing', async () => {
    const catalog = new DrizzleAssetCatalogRepository(db);
    const repository = new DrizzleQuoteRepository(db);
    const provider = {
      fetchDailyPrices: async () => err(domainError(TesouroErrorCode.UNAVAILABLE, {})),
    };

    await handleTesouroSync({ catalog, repository, provider, enqueueSnapshotRebuild: noRebuild });

    expect(await catalog.findByCode('Tesouro Selic 2029')).toBeNull();
  });

  const ibovQuoteProvider = {
    fetchQuote: async () =>
      ok({
        ticker: '^BVSP',
        price: Money.fromString('130000.00'),
        quotedAt: new Date(),
        source: 'brapi_free',
      }),
  };

  const clockOn = (day: string) => ({
    now: () => new Date(`${day}T21:00:00Z`),
    today: () => BusinessDate.of(day),
  });

  type SgsCode = 'CDI' | 'IPCA' | 'SELIC' | 'IBOV';
  interface SeenRequest {
    readonly code: SgsCode;
    readonly since: BusinessDate;
    readonly until: BusinessDate;
  }

  /** One CDI point on each window's last day; every other series empty. */
  function recordingProvider(
    seen: SeenRequest[],
    fail?: (request: SeenRequest) => ReturnType<typeof domainError> | null,
  ) {
    return {
      fetchSeries: async (code: SgsCode, since: BusinessDate, until: BusinessDate) => {
        const request = { code, since, until };
        seen.push(request);
        const failure = fail?.(request) ?? null;
        if (failure) return err(failure);
        if (code !== 'CDI') return ok([]);
        return ok([
          { code, date: until, value: Quantity.fromString('0.050788'), source: 'bcb_sgs' },
        ]);
      },
    };
  }

  const years = (since: BusinessDate, until: BusinessDate): number =>
    (Date.parse(until) - Date.parse(since)) / (365.25 * 86_400_000);

  it('backfills from scratch on first load, then fetches only since the latest stored point', async () => {
    const indexSeriesRepository = new DrizzleIndexSeriesRepository(db);
    const seen: SeenRequest[] = [];
    const provider = recordingProvider(seen);

    await handleBcbSync({
      clock: clockOn('2026-03-16'),
      indexSeriesRepository,
      provider,
      quoteProvider: ibovQuoteProvider,
    });

    expect(await indexSeriesRepository.latestDate('CDI')).toBe('2026-03-16');
    // First run for CDI had nothing stored — backfilled from the far-past default.
    expect(seen[0]).toEqual({ code: 'CDI', since: '2000-01-01', until: '2009-12-31' });

    seen.length = 0;
    await handleBcbSync({
      clock: clockOn('2026-03-17'),
      indexSeriesRepository,
      provider,
      quoteProvider: ibovQuoteProvider,
    });

    // Second run fetches only since the point already stored — not a full re-backfill.
    expect(seen.filter((r) => r.code === 'CDI')).toEqual([
      { code: 'CDI', since: '2026-03-16', until: '2026-03-17' },
    ]);

    // IBOV, fetched via QuoteProvider, also lands in index_series.
    const ibovRows = await pool.query(
      `SELECT count(*)::int AS n FROM index_series WHERE code = 'IBOV'`,
    );
    expect(ibovRows.rows[0]?.n).toBeGreaterThan(0);
  });

  it('#123: a 26-year backfill is several requests of at most 10 years, in order, each stored', async () => {
    const indexSeriesRepository = new DrizzleIndexSeriesRepository(db);
    const seen: SeenRequest[] = [];

    await handleBcbSync({
      clock: clockOn('2026-09-28'),
      indexSeriesRepository,
      provider: recordingProvider(seen),
      quoteProvider: ibovQuoteProvider,
    });

    for (const code of ['CDI', 'IPCA', 'SELIC'] as const) {
      expect(seen.filter((r) => r.code === code)).toEqual([
        { code, since: '2000-01-01', until: '2009-12-31' },
        { code, since: '2010-01-01', until: '2019-12-31' },
        { code, since: '2020-01-01', until: '2026-09-28' },
      ]);
    }
    expect(seen.every((r) => years(r.since, r.until) < 10)).toBe(true);

    const cdi = await pool.query<{ date: string }>(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date FROM index_series WHERE code = 'CDI' ORDER BY date`,
    );
    expect(cdi.rows.map((r) => r.date)).toEqual(['2009-12-31', '2019-12-31', '2026-09-28']);
  });

  it('#123: a failed window keeps the windows before it, and the next run resumes after them', async () => {
    const indexSeriesRepository = new DrizzleIndexSeriesRepository(db);
    const seen: SeenRequest[] = [];
    const rejectSecondCdiWindow = (r: SeenRequest) =>
      r.code === 'CDI' && r.since === '2010-01-01'
        ? domainError(BcbSgsErrorCode.REJECTED, { code: 'CDI', status: 406, message: null })
        : null;

    // BR-008-27: the job fails, so the queue retries it and a persistent
    // failure dead-letters into an alert — but only once the cycle is done.
    await expect(
      handleBcbSync({
        clock: clockOn('2026-09-28'),
        indexSeriesRepository,
        provider: recordingProvider(seen, rejectSecondCdiWindow),
        quoteProvider: ibovQuoteProvider,
      }),
    ).rejects.toThrow('bcb.sync: CDI did not complete');

    // The failure ends CDI's walk; the first window stays stored, and the
    // other series and IBOV are not held back by it.
    expect(seen.filter((r) => r.code === 'CDI').map((r) => r.since)).toEqual([
      '2000-01-01',
      '2010-01-01',
    ]);
    expect(seen.filter((r) => r.code === 'SELIC')).toHaveLength(3);
    expect(await indexSeriesRepository.latestDate('CDI')).toBe('2009-12-31');
    expect(await indexSeriesRepository.latestDate('SELIC')).toBeNull();
    expect(await indexSeriesRepository.latestDate('IBOV')).toBe('2026-09-28');

    seen.length = 0;
    await handleBcbSync({
      clock: clockOn('2026-09-28'),
      indexSeriesRepository,
      provider: recordingProvider(seen),
      quoteProvider: ibovQuoteProvider,
    });

    // Resumes from the last stored point; the stored span is not re-walked.
    expect(seen.filter((r) => r.code === 'CDI')).toEqual([
      { code: 'CDI', since: '2009-12-31', until: '2019-12-30' },
      { code: 'CDI', since: '2019-12-31', until: '2026-09-28' },
    ]);
    expect(await indexSeriesRepository.latestDate('CDI')).toBe('2026-09-28');
  });

  it('#123: a window BCB holds nothing for is skipped, not a failure', async () => {
    const indexSeriesRepository = new DrizzleIndexSeriesRepository(db);
    const seen: SeenRequest[] = [];
    const firstCdiWindowEmpty = (r: SeenRequest) =>
      r.code === 'CDI' && r.since === '2000-01-01'
        ? domainError(BcbSgsErrorCode.NO_DATA, { code: 'CDI', status: 404, message: null })
        : null;

    await handleBcbSync({
      clock: clockOn('2026-09-28'),
      indexSeriesRepository,
      provider: recordingProvider(seen, firstCdiWindowEmpty),
      quoteProvider: ibovQuoteProvider,
    });

    expect(seen.filter((r) => r.code === 'CDI')).toHaveLength(3);
    expect(await indexSeriesRepository.latestDate('CDI')).toBe('2026-09-28');
  });
});
