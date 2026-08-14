import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { BusinessDate, FakeClock } from '@/core/shared/clock';
import type { AssetId } from '@/core/shared/ids';
import { TransactionId, UserId, type InstitutionId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import {
  computeTotalValue,
  type Transaction,
  type TransactionType,
} from '@/core/ledger/transaction';
import { B3TradingCalendar } from '@/adapters/calendar/b3-calendar';
import { DrizzleAssetCatalogRepository } from '@/adapters/db/asset-catalog-repository';
import { DrizzleIndexSeriesRepository } from '@/adapters/db/index-series-repository';
import { DrizzleQuoteRepository } from '@/adapters/db/quote-repository';
import { DrizzleValuationSnapshotRepository } from '@/adapters/db/valuation-snapshot-repository';
import {
  buildSnapshot,
  buildSnapshotSeries,
  loadValuationContext,
  computeSnapshots,
  persistSnapshots,
  quantizeSnapshot,
  serializeSnapshot,
  snapshotsEqual,
  valuePortfolioAt,
  type SnapshotDependencies,
} from '@/core/valuation/snapshot';
import type { DailyValuationSnapshot } from '@/core/valuation/ports';
import { aContract, FakeFixedIncomeContracts } from '@/core/valuation/test-support';
import { handleFixedIncomeAccrue, handleValuationSnapshot } from '@/worker/handlers/valuation';
import { withTenant } from '@/db/tenant';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';

/**
 * SPEC-009 integration — real Postgres for the price history, the index
 * series and the snapshot table (so AR-06/AR-07's NUMERIC round trip and the
 * RLS-scoped writes actually happen), with a controllable `FakeClock` and a
 * hand-written contract fake for the SPEC-005 table that does not exist yet.
 */
describe('SPEC-009 valuation snapshots (integration)', () => {
  let database: TestDatabase;
  let appPool: Pool;
  let migratorPool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  const userId = UserId.generate();
  let petr: AssetId;
  let tesouro: AssetId;
  let cdb: AssetId;

  const calendar = new B3TradingCalendar();
  const d = (value: string): BusinessDate => BusinessDate.of(value);
  const to8 = (value: Money): string => value.toDecimal().toFixed(8);

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.migrationUrl);
    // max > 1 deliberately: a rebuild reads shared reference tables while a
    // tenant transaction may be open, and production pools are not size 1.
    appPool = new Pool({ connectionString: database.appUrl, max: 5 });
    migratorPool = new Pool({ connectionString: database.migrationUrl, max: 1 });
    db = drizzle(appPool, { schema });
  }, 180_000);

  afterAll(async () => {
    // Both halves (TS-03): this file's tenants and the shared reference rows it
    // seeded go, so a later file does not inherit either.
    await resetUsers(database.migrationUrl);
    await resetLedger(database.migrationUrl);
    await migratorPool.query('TRUNCATE index_series, price_quotes, latest_quotes CASCADE');
    await appPool.end();
    await migratorPool.end();
    await database.stop();
  });

  beforeEach(async () => {
    await migratorPool.query(
      'TRUNCATE daily_valuation_snapshots, positions, transactions, index_series, price_quotes, latest_quotes, assets CASCADE',
    );
    await resetUsers(database.migrationUrl);
    await seedUser(database.migrationUrl, userId);

    const catalog = new DrizzleAssetCatalogRepository(db);
    petr = (
      await catalog.upsertByCode({ code: 'PETR4', name: 'Petrobras PN', assetClass: 'stock' })
    ).id;
    tesouro = (
      await catalog.upsertByCode({
        code: 'Tesouro IPCA+ 2035',
        name: 'Tesouro IPCA+ 2035',
        assetClass: 'tesouro_direto',
      })
    ).id;
    cdb = (
      await catalog.upsertByCode({ code: 'CDB BANCO X', name: 'CDB Banco X', assetClass: 'cdb' })
    ).id;
  });

  // -------------------------------------------------------------------------

  let sequence = 0;
  function tx(
    assetId: AssetId,
    type: TransactionType,
    tradeDate: string,
    quantity: string,
    unitPrice: string,
  ): Transaction {
    sequence += 1;
    const q = Quantity.fromString(quantity);
    const price = Money.fromString(unitPrice);
    return {
      id: TransactionId.generate(),
      userId,
      assetId,
      institutionId: null as InstitutionId | null,
      type,
      status: 'active',
      tradeDate: d(tradeDate),
      quantity: q,
      unitPrice: price,
      fees: Money.zero(),
      totalValue: computeTotalValue(type, q, price, Money.zero()),
      ratio: null,
      naturalKey: `${tradeDate}|${assetId}|${type}|${quantity}|${unitPrice}|${sequence}`,
      occurrence: 1,
      importBatchId: null,
      isManual: true,
      isUserModified: false,
      createdAt: new Date(Date.UTC(2026, 0, 1, 12, 0, 0, sequence)),
      updatedAt: new Date(Date.UTC(2026, 0, 1, 12, 0, 0, sequence)),
    };
  }

  async function seedPrices(): Promise<void> {
    const quotes = new DrizzleQuoteRepository(db);
    await quotes.upsertClosePrice({
      assetId: petr,
      date: d('2026-03-20'),
      close: Money.fromString('38.42'),
      source: 'brapi_free',
    });
    // BR-009-06: the value written here is `PU Venda Manhã` — the sell price —
    // because that is the column `adapters/quotes/tesouro.ts` now ingests.
    await quotes.upsertClosePrice({
      assetId: tesouro,
      date: d('2026-03-20'),
      close: Money.fromString('3413.70'),
      source: 'tesouro_transparente',
    });
  }

  async function seedCdi(): Promise<void> {
    const series = new DrizzleIndexSeriesRepository(db);
    await series.upsertPoints(
      [
        ['2026-03-16', '0.05078803'],
        ['2026-03-17', '0.05078803'],
        ['2026-03-18', '0.04903749'],
        ['2026-03-19', '0.04903749'],
        ['2026-03-20', '0.04903749'],
      ].map(([date, value]) => ({
        code: 'CDI' as const,
        date: d(String(date)),
        value: Quantity.fromString(String(value)),
        source: 'bcb_sgs',
      })),
    );
  }

  function contracts(): FakeFixedIncomeContracts {
    // SPEC-005 (#8) owns `fixed_income_contracts` and it does not exist yet, so
    // this stays a hand-written fake (TS-02) even in integration. Everything
    // else in this suite is real Postgres.
    return new FakeFixedIncomeContracts().set(aContract(cdb, { issueDate: '2026-03-16' }));
  }

  /**
   * The read-only half — everything `loadValuationContext` needs and nothing
   * it must not have. Typed as `Omit<…, 'snapshots'>` rather than handing it a
   * repository it never calls, so a query path cannot acquire a write port by
   * accident.
   */
  function readDeps(): Omit<SnapshotDependencies, 'snapshots'> {
    return {
      calendar,
      prices: new DrizzleQuoteRepository(db),
      contracts: contracts(),
      indexSeries: new DrizzleIndexSeriesRepository(db),
      assets: new DrizzleAssetCatalogRepository(db),
    };
  }

  /**
   * The production composition, in the order the worker handler uses it:
   * compute with no transaction open, then persist inside `withTenant`.
   * Calling `rebuildSnapshots` here instead would read shared tables from
   * inside the tenant transaction — which is exactly the shape that deadlocks
   * a small pool, so the test exercises the shape the handler actually runs.
   */
  async function rebuildFor(
    ledger: readonly Transaction[],
    range: { from: BusinessDate; to: BusinessDate; currentDate?: BusinessDate },
  ): Promise<readonly DailyValuationSnapshot[]> {
    const computed = await computeSnapshots(readDeps(), ledger, range);
    if (!computed.ok) throw new Error(`rebuild failed: ${computed.error.code}`);
    await withTenant(
      userId,
      async (tenantTx) =>
        persistSnapshots(
          new DrizzleValuationSnapshotRepository(tenantTx, userId),
          computed.value,
          range.from,
        ),
      db,
    );
    return computed.value;
  }

  async function storedBetween(
    from: BusinessDate,
    to: BusinessDate,
  ): Promise<readonly DailyValuationSnapshot[]> {
    return withTenant(
      userId,
      async (tenantTx) =>
        new DrizzleValuationSnapshotRepository(tenantTx, userId).listRange(from, to),
      db,
    );
  }

  const threeMethodLedger = (): readonly Transaction[] => [
    tx(petr, 'buy', '2026-03-16', '100', '32.15'),
    tx(tesouro, 'buy', '2026-03-16', '3.5', '3200'),
    tx(cdb, 'buy', '2026-03-16', '1', '10000'),
  ];

  // -------------------------------------------------------------------------

  it('AC-5: Tesouro is valued at the published sell price and is NOT flagged estimated', async () => {
    await seedPrices();
    await seedCdi();
    const ledger = [tx(tesouro, 'buy', '2026-03-16', '3.5', '3200')];

    const context = await loadValuationContext(
      readDeps(),
      ledger,
      d('2026-03-20'),
      d('2026-03-20'),
    );
    const valued = valuePortfolioAt(context, ledger, d('2026-03-20'), 'historical');
    expect(valued.ok).toBe(true);
    if (!valued.ok) return;

    // 3,5 × 3.413,70 = 11.947,95
    expect(to8(valued.value[0]?.value ?? Money.zero())).toBe('11947.95000000');
    expect(valued.value[0]?.estimated).toBe(false);
    expect(valued.value[0]?.method).toBe('tesouro_sell_price');
    // BR-009-12: observed, but still gross of IR/IOF.
    expect(valued.value[0]?.grossOfTaxes).toBe(true);
  });

  it('AC-2: a historical point does not move when the intraday quote changes', async () => {
    await seedPrices();
    const quotes = new DrizzleQuoteRepository(db);
    const ledger = [tx(petr, 'buy', '2026-03-16', '100', '32.15')];

    async function historicalTotal(): Promise<string> {
      const snapshots = await rebuildFor(ledger, { from: d('2026-03-20'), to: d('2026-03-20') });
      return to8(snapshots[0]?.totalValue ?? Money.zero());
    }

    const before = await historicalTotal();
    expect(before).toBe('3842.00000000');

    // An intraday quote lands, wildly different from the close.
    await quotes.upsertLatestQuote({
      assetId: petr,
      price: Money.fromString('45.00'),
      quotedAt: new Date('2026-03-20T18:00:00Z'),
      fetchedAt: new Date('2026-03-20T18:00:00Z'),
      source: 'brapi_free',
    });

    // BR-009-02: the same historical date must render identically. If it did
    // not, a past chart point would move depending on what time of day the
    // page was loaded.
    expect(await historicalTotal()).toBe('3842.00000000');
    expect(await historicalTotal()).toBe(before);
  });

  it('AC-16: the portfolio total equals the sum of its parts across all three methods', async () => {
    await seedPrices();
    await seedCdi();
    const ledger = threeMethodLedger();

    await rebuildFor(ledger, { from: d('2026-03-20'), to: d('2026-03-20') });
    const stored = await storedBetween(d('2026-03-20'), d('2026-03-20'));

    const snapshot = stored[0];
    if (snapshot === undefined) throw new Error('no snapshot stored');
    //   listed   100 × 38,42        =  3.842,00
    //   tesouro  3,5 × 3.413,70     = 11.947,95
    //   accrued  10.000 × 1,00219797058841565625…
    //                               = 10.021,97970588…
    //   total                       = 25.811,92970588
    expect(to8(snapshot.totalValue)).toBe('25811.92970588');
    expect(to8(snapshot.byAssetClass.get('stock') ?? Money.zero())).toBe('3842.00000000');
    expect(to8(snapshot.byAssetClass.get('tesouro_direto') ?? Money.zero())).toBe('11947.95000000');
    expect(to8(snapshot.byAssetClass.get('cdb') ?? Money.zero())).toBe('10021.97970588');

    // TS-12's cross-report invariant, asserted against what the column
    // actually round-tripped rather than against the in-memory value.
    let sum = Money.zero();
    for (const value of snapshot.byAssetClass.values()) sum = sum.plus(value);
    expect(sum.equals(snapshot.totalValue)).toBe(true);

    // BR-009-11: the accrued CDB marks the day.
    expect(snapshot.hasEstimates).toBe(true);
    // 3.215,00 + 11.200,00 + 10.000,00
    expect(to8(snapshot.netContributions)).toBe('24415.00000000');
  });

  it('DM-4 / AC-14: a full rebuild reproduces the incrementally-maintained snapshots exactly', async () => {
    await seedPrices();
    await seedCdi();
    const ledger = [
      ...threeMethodLedger(),
      tx(petr, 'buy', '2026-03-17', '50', '33.10'),
      tx(petr, 'dividend', '2026-03-18', '150', '0.72'),
      tx(petr, 'sell', '2026-03-19', '40', '37.55'),
      tx(tesouro, 'buy', '2026-03-18', '1.25', '3390'),
    ];

    const from = d('2026-03-16');
    const to = d('2026-03-22');

    const rebuilt = await rebuildFor(ledger, { from, to });

    // The independent path: value each date from scratch and derive the flow
    // totals from the whole ledger, rather than carrying them forward.
    const context = await loadValuationContext(readDeps(), ledger, from, to);
    const dates = rebuilt.map((snapshot) => snapshot.date);
    const independent = dates.map((date) => {
      const valued = valuePortfolioAt(context, ledger, date, 'historical');
      if (!valued.ok) throw new Error(`valuation failed on ${date}`);
      return buildSnapshot(date, valued.value, ledger);
    });

    expect(rebuilt).toHaveLength(independent.length);
    for (const [index, snapshot] of rebuilt.entries()) {
      const reference = independent[index];
      if (reference === undefined) throw new Error('missing reference');
      expect(snapshotsEqual(snapshot, reference), snapshot.date).toBe(true);
    }

    // And what was *persisted* must equal it too — a repository that lost a
    // digit on the way through NUMERIC/jsonb would pass every in-memory check.
    const stored = await storedBetween(from, to);
    // Compared at the **persisted** precision. `NUMERIC(20,8)` and the jsonb
    // breakdown both hold eight decimal places once `persistSnapshots` has
    // quantised them, so what came back must equal the independently computed
    // series put through the same, explicit, boundary.
    expect(stored.map(serializeSnapshot)).toEqual(
      independent.map((snapshot) => serializeSnapshot(quantizeSnapshot(snapshot))),
    );

    // AC-16 on every stored row, not just one: the parts add to the total
    // exactly, which is only true because the total is the sum of the
    // *quantised* parts (TS-12's cross-report invariant).
    for (const snapshot of stored) {
      let sum = Money.zero();
      for (const value of snapshot.byAssetClass.values()) sum = sum.plus(value);
      expect(sum.equals(snapshot.totalValue), snapshot.date).toBe(true);
    }

    // The property is worthless if the fixture is trivial.
    expect(stored.some((snapshot) => snapshot.earningsToDate.isPositive())).toBe(true);
    expect(stored.some((snapshot) => snapshot.hasEstimates)).toBe(true);

    // The carried-forward series agrees as well (TS-08 in the same shape the
    // daily job runs it).
    const valuedByDate = new Map(
      dates.map((date) => {
        const valued = valuePortfolioAt(context, ledger, date, 'historical');
        if (!valued.ok) throw new Error('valuation failed');
        return [date, valued.value] as const;
      }),
    );
    expect(buildSnapshotSeries(dates, valuedByDate, ledger).map(serializeSnapshot)).toEqual(
      independent.map(serializeSnapshot),
    );

    // And a second rebuild of the same range is byte-identical to the first —
    // the property that makes a snapshot safe to treat as a cache at all.
    await rebuildFor(ledger, { from, to });
    expect((await storedBetween(from, to)).map(serializeSnapshot)).toEqual(
      stored.map(serializeSnapshot),
    );
  });

  it('AC-15: editing a backdated transaction rebuilds snapshots forward from that date', async () => {
    await seedPrices();
    const original = [tx(petr, 'buy', '2026-03-16', '100', '32.15')];

    const before = await rebuildFor(original, { from: d('2026-03-16'), to: d('2026-03-22') });
    expect(before).toHaveLength(7);
    // No close before 2026-03-20, so the first days fall back to cost.
    expect(to8(before[4]?.totalValue ?? Money.zero())).toBe('3842.00000000');

    // The user corrects the quantity to 150, six days after the fact. Only
    // dates from the trade date forward may change — and they must, because
    // the whole point of BR-009-18 is that the *chart* changes, not just today.
    const corrected = [{ ...(original[0] as Transaction), quantity: Quantity.fromString('150') }];
    await rebuildFor(corrected, { from: d('2026-03-16'), to: d('2026-03-22') });
    const after = await storedBetween(d('2026-03-16'), d('2026-03-22'));

    // 150 × 38,42 = 5.763,00, on 20 March and every day after it.
    expect(to8(after[4]?.totalValue ?? Money.zero())).toBe('5763.00000000');
    expect(to8(after[6]?.totalValue ?? Money.zero())).toBe('5763.00000000');
    // 150 × 32,15 = 4.822,50 contributed, on the earliest date too.
    expect(to8(after[0]?.netContributions ?? Money.zero())).toBe('4822.50000000');
    // Still exactly seven rows: the rebuild replaced, it did not append.
    expect(after).toHaveLength(7);
  });

  it('a partial rebuild leaves earlier snapshots untouched', async () => {
    await seedPrices();
    const ledger = [tx(petr, 'buy', '2026-03-16', '100', '32.15')];

    await rebuildFor(ledger, { from: d('2026-03-16'), to: d('2026-03-22') });

    // Rebuild only from 20 March forward.
    await rebuildFor(ledger, { from: d('2026-03-20'), to: d('2026-03-22') });
    const rows = await storedBetween(d('2026-03-16'), d('2026-03-22'));
    // 16–19 survive from the first pass; 20–22 were rewritten. Seven rows, no gap.
    expect(rows.map((row) => row.date)).toEqual([
      '2026-03-16',
      '2026-03-17',
      '2026-03-18',
      '2026-03-19',
      '2026-03-20',
      '2026-03-21',
      '2026-03-22',
    ]);
  });

  // -------------------------------------------------------------------------

  describe('worker handlers', () => {
    async function seedLedgerRows(rows: readonly Transaction[]): Promise<void> {
      for (const row of rows) {
        await migratorPool.query(
          `INSERT INTO transactions (id, user_id, asset_id, institution_id, type, status,
             trade_date, quantity, unit_price, fees, total_value, ratio, natural_key,
             occurrence, import_batch_id, is_manual, is_user_modified, created_at, updated_at)
           VALUES ($1,$2,$3,NULL,$4,'active',$5,$6,$7,$8,$9,NULL,$10,1,NULL,true,false,$11,$11)`,
          [
            row.id,
            row.userId,
            row.assetId,
            row.type,
            row.tradeDate,
            row.quantity.toString(),
            row.unitPrice.toString(),
            row.fees.toString(),
            row.totalValue.toString(),
            row.naturalKey,
            row.createdAt,
          ],
        );
      }
    }

    it('valuation.snapshot writes a tenant’s history, and AR-19 makes a retry a no-op', async () => {
      await seedPrices();
      await seedCdi();
      await seedLedgerRows(threeMethodLedger());

      const overrides = {
        database: db,
        clock: new FakeClock('2026-03-20T22:00:00Z'),
        calendar,
        contracts: contracts(),
      };

      const first = await handleValuationSnapshot({ from: '2026-03-16' }, overrides);
      expect(first.tenants).toBe(1);
      expect(first.failures).toBe(0);
      expect(first.snapshots).toBe(5); // 16..20 March inclusive

      const { rows: afterFirst } = await migratorPool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM daily_valuation_snapshots',
      );
      expect(afterFirst[0]?.n).toBe(5);

      // A simulated pg-boss retry, same instant. Idempotent: same rows, same
      // figures, no duplicates — the PK is `(user_id, date)` and the rebuild
      // deletes before it writes.
      const second = await handleValuationSnapshot({ from: '2026-03-16' }, overrides);
      expect(second.snapshots).toBe(5);
      const { rows: afterSecond } = await migratorPool.query<{ n: number; total: string }>(
        'SELECT count(*)::int AS n, sum(total_value) AS total FROM daily_valuation_snapshots',
      );
      expect(afterSecond[0]?.n).toBe(5);

      const { rows: onTheDay } = await migratorPool.query<{ total_value: string }>(
        "SELECT total_value FROM daily_valuation_snapshots WHERE date = '2026-03-20'",
      );
      expect(onTheDay[0]?.total_value).toBe('25811.92970588');
    });

    it('never starts a rebuild before the ledger does', async () => {
      await seedPrices();
      await seedCdi();
      await seedLedgerRows(threeMethodLedger());

      // `from` predates the first trade by two months. Writing a run of
      // zero-valued days that never existed would put a false flat line at the
      // start of every user's Portfolio Value chart.
      const summary = await handleValuationSnapshot(
        { from: '2026-01-01' },
        {
          database: db,
          clock: new FakeClock('2026-03-20T22:00:00Z'),
          calendar,
          contracts: contracts(),
        },
      );
      expect(summary.snapshots).toBe(5);
      const { rows } = await migratorPool.query<{ min: string }>(
        'SELECT min(date)::text AS min FROM daily_valuation_snapshots',
      );
      expect(rows[0]?.min).toBe('2026-03-16');
    });

    it('a tenant with no transactions gets no snapshots — not a row of zeroes', async () => {
      const summary = await handleValuationSnapshot(
        { userId },
        {
          database: db,
          clock: new FakeClock('2026-03-20T22:00:00Z'),
          calendar,
          contracts: contracts(),
        },
      );
      expect(summary.tenants).toBe(1);
      expect(summary.snapshots).toBe(0);
      expect(summary.failures).toBe(0);
      const { rows } = await migratorPool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM daily_valuation_snapshots',
      );
      expect(rows[0]?.n).toBe(0);
    });

    it('BR-009-14/AR-18: fixedincome.accrue does nothing on a B3 holiday', async () => {
      await seedPrices();
      await seedCdi();
      await seedLedgerRows(threeMethodLedger());

      // 2026-04-03 is Sexta-feira Santa — no CDI is published, so there is
      // nothing to accrue and a re-run would recompute an identical figure.
      const summary = await handleFixedIncomeAccrue({
        database: db,
        clock: new FakeClock('2026-04-03T22:00:00Z'),
        calendar,
        contracts: contracts(),
      });
      expect(summary).toEqual({ tenants: 0, snapshots: 0, failures: 0 });
      const { rows } = await migratorPool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM daily_valuation_snapshots',
      );
      expect(rows[0]?.n).toBe(0);
    });

    it('BR-009-14: fixedincome.accrue refreshes only today’s snapshot', async () => {
      await seedPrices();
      await seedCdi();
      await seedLedgerRows(threeMethodLedger());

      const summary = await handleFixedIncomeAccrue({
        database: db,
        clock: new FakeClock('2026-03-20T22:00:00Z'),
        calendar,
        contracts: contracts(),
      });
      expect(summary.snapshots).toBe(1);
      const { rows } = await migratorPool.query<{ date: string; total_value: string }>(
        'SELECT date::text AS date, total_value FROM daily_valuation_snapshots',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.date).toBe('2026-03-20');
      expect(rows[0]?.total_value).toBe('25811.92970588');
    });

    it('one tenant’s unprocessable ledger does not cost every other tenant their day', async () => {
      await seedPrices();
      await seedCdi();
      const other = UserId.generate();
      await seedUser(database.migrationUrl, other);
      await seedLedgerRows(threeMethodLedger());
      // A sale of more than was ever held — the position engine refuses it.
      await seedLedgerRows([{ ...tx(petr, 'sell', '2026-03-17', '999', '38.42'), userId: other }]);

      const summary = await handleValuationSnapshot(
        { from: '2026-03-16' },
        {
          database: db,
          clock: new FakeClock('2026-03-20T22:00:00Z'),
          calendar,
          contracts: contracts(),
        },
      );
      expect(summary.tenants).toBe(2);
      expect(summary.failures).toBe(1);
      // The healthy tenant still got their five days.
      expect(summary.snapshots).toBe(5);
      const { rows } = await migratorPool.query<{ user_id: string; n: number }>(
        'SELECT user_id, count(*)::int AS n FROM daily_valuation_snapshots GROUP BY user_id',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.user_id).toBe(userId);
    });
  });
});
