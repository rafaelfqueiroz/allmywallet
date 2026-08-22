import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { BusinessDate, FakeClock } from '@/core/shared/clock';
import { TransactionId, UserId, WalletId, type AssetId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { computeTotalValue, type TransactionType } from '@/core/ledger/transaction';
import { B3TradingCalendar } from '@/adapters/calendar/b3-calendar';
import { DrizzleAssetCatalogRepository } from '@/adapters/db/asset-catalog-repository';
import { DrizzleQuoteRepository } from '@/adapters/db/quote-repository';
import { FakeFixedIncomeContracts } from '@/core/valuation/test-support';
import { handleValuationSnapshot } from '@/worker/handlers/valuation';
import { runReportQuery } from '@/core/reporting/base-query';
import { buildPortfolioValueReport } from '@/core/reporting/portfolio-value/report';
import { buildEarningsReport } from '@/core/reporting/earnings/report';
import { DrizzleReportDataPort } from '@/app/(app)/reports/data';
import { withTenant } from '@/db/tenant';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers, resetWallets } from '../support/reset';
import { seedUser } from '../support/users';

/**
 * SPEC-014 BR-014-13 / DL-014-07 — **the two reports must agree about how much
 * income was received.**
 *
 * The same reasoning as SPEC-013 DL-013-06, applied to the other figure two
 * screens can disagree about. Patrimônio's growth decomposition reports
 * earnings as `closing.earningsToDate − opening.earningsToDate`, read from
 * `daily_valuation_snapshots`; Proventos sums the earning transactions
 * directly. Those are **two independent paths through two different tables**,
 * and nothing but a test keeps them in step.
 *
 * They agree today because both filter the same four types on `active` rows at
 * pay date (`isEarnings` and `applyFlow` in `core/valuation/snapshot.ts`, and
 * `listEarnings` in the report port). If either definition ever drifts — a
 * fifth type, a status filter, an ex-date recognition — this fails, which is
 * the whole point of asserting it rather than reading it.
 *
 * Integration rather than unit, because the snapshot half only exists once the
 * real pipeline has run: a fake would agree with the report by construction and
 * prove nothing.
 */
describe('SPEC-014 BR-014-13 — Proventos and Patrimônio agree on income', () => {
  let database: TestDatabase;
  let appPool: Pool;
  let migratorPool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  const userId = UserId.generate();
  const walletId = WalletId.generate();
  let petr: AssetId;

  const calendar = new B3TradingCalendar();
  const d = (value: string): BusinessDate => BusinessDate.of(value);

  /** Inside the same year, so a YTD period covers all of it. */
  const BUY = '2026-01-12';
  const FIRST_PAYMENT = '2026-02-10';
  const SECOND_PAYMENT = '2026-03-11';
  const AS_OF = '2026-03-20';

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.migrationUrl);

    appPool = new Pool({ connectionString: database.appUrl, max: 5 });
    migratorPool = new Pool({ connectionString: database.migrationUrl, max: 1 });
    db = drizzle(appPool, { schema });

    // TS-03: CI shares one Postgres across suites.
    await migratorPool.query(
      'TRUNCATE daily_valuation_snapshots, positions, transactions, price_quotes, latest_quotes CASCADE',
    );
    await resetWallets(database.migrationUrl);
    await resetLedger(database.migrationUrl);
    await resetUsers(database.migrationUrl);
    await seedUser(database.migrationUrl, userId);

    const catalog = new DrizzleAssetCatalogRepository(db);
    petr = (
      await catalog.upsertByCode({ code: 'PETR4-XR', name: 'Petrobras PN', assetClass: 'stock' })
    ).id;

    await new DrizzleQuoteRepository(db).upsertClosePrice({
      assetId: petr,
      date: d(AS_OF),
      close: Money.fromString('40'),
      source: 'brapi_free',
    });

    await seed('buy', BUY, '100', '30');
    await seed('dividend', FIRST_PAYMENT, '100', '1.20');
    await seed('jcp', SECOND_PAYMENT, '100', '0.55');

    await withTenant(
      userId,
      async (tx) => {
        await tx.insert(schema.wallets).values({
          id: walletId,
          userId,
          name: 'Aposentadoria',
          description: null,
          goal: null,
          color: null,
        });
        await tx.insert(schema.walletAllocationEvents).values({
          id: TransactionId.generate(),
          userId,
          walletId,
          assetId: petr,
          quantity: Quantity.fromString('100'),
          effectiveOn: BUY,
          cause: 'buy',
        });
      },
      db,
    );

    // The pipeline that produces the figure Patrimônio reads.
    await handleValuationSnapshot(
      { from: BUY },
      {
        database: db,
        clock: new FakeClock(`${AS_OF}T22:00:00Z`),
        calendar,
        contracts: new FakeFixedIncomeContracts(),
      },
    );
  }, 300_000);

  afterAll(async () => {
    await resetWallets(database.migrationUrl);
    await resetLedger(database.migrationUrl);
    await resetUsers(database.migrationUrl);
    await migratorPool.query('TRUNCATE price_quotes, latest_quotes CASCADE');
    await appPool.end();
    await migratorPool.end();
    await database.stop();
  });

  let sequence = 0;
  async function seed(
    type: TransactionType,
    tradeDate: string,
    quantity: string,
    unitPrice: string,
  ): Promise<void> {
    sequence += 1;
    const q = Quantity.fromString(quantity);
    const price = Money.fromString(unitPrice);
    await migratorPool.query(
      `INSERT INTO transactions (id, user_id, asset_id, institution_id, type, status,
         trade_date, quantity, unit_price, fees, total_value, ratio, natural_key,
         occurrence, import_batch_id, is_manual, is_user_modified)
       VALUES ($1,$2,$3,NULL,$4,'active',$5,$6,$7,0,$8,NULL,$9,1,NULL,true,false)`,
      [
        TransactionId.generate(),
        userId,
        petr,
        type,
        tradeDate,
        q.toString(),
        price.toString(),
        computeTotalValue(type, q, price, Money.zero()).toString(),
        `xr|${tradeDate}|${type}|${sequence}`,
      ],
    );
  }

  async function reports(scope: 'portfolio' | 'wallet') {
    return withTenant(
      userId,
      async (tx) => {
        const port = new DrizzleReportDataPort(tx, userId, new FakeClock(`${AS_OF}T22:00:00Z`));
        const query = await runReportQuery(
          port,
          {
            period: { kind: 'ytd' },
            scope: scope === 'portfolio' ? { kind: 'portfolio' } : { kind: 'wallet', walletId },
            grouping: 'asset_class',
            today: d(AS_OF),
          },
          await port.earliestSnapshotDate(),
        );
        if (!query.ok) throw new Error(`query failed: ${query.error.code}`);

        const [opening, lastImportAt, earnings, trailing, previous, events] = await Promise.all([
          port.findSnapshotBefore(query.value.range.from),
          port.lastImportAt(),
          port.listEarnings(query.value.range.from, query.value.range.to),
          port.listEarnings(d('2025-03-20'), query.value.range.to),
          port.listEarnings(d('2025-01-01'), d('2025-03-20')),
          port.listAllocationEvents(query.value.range.to),
        ]);

        const assetIds = [...new Set(earnings.map((earning) => earning.assetId))];
        const descriptors = assetIds.length === 0 ? [] : await port.describeAssets(assetIds);

        return {
          patrimonio: buildPortfolioValueReport({
            query: query.value,
            opening,
            grouping: 'asset_class',
            today: d(AS_OF),
            lastImportAt,
          }),
          proventos: buildEarningsReport({
            query: query.value,
            earnings,
            trailing,
            previous,
            allocationEvents: events,
            descriptors,
          }),
        };
      },
      db,
    );
  }

  it('reports the same income at portfolio scope, exactly', async () => {
    const { patrimonio, proventos } = await reports('portfolio');

    if (patrimonio.decomposition.kind !== 'available') {
      throw new Error('expected a portfolio decomposition');
    }

    // 100 × 1,20 + 100 × 0,55 = 175, by both routes: one summing the ledger's
    // earning rows, the other differencing a stored cumulative column.
    expect(proventos.total.toString()).toBe('175');
    expect(patrimonio.decomposition.value.earnings.equals(proventos.total)).toBe(true);
  });

  /**
   * The one place they are *not* comparable, stated so nobody later "fixes"
   * it into an equality. `daily_valuation_snapshots` has no wallet dimension
   * (#50), so Patrimônio withholds its decomposition at wallet scope rather
   * than reporting the portfolio's figure under a wallet's heading — while
   * Proventos answers, because BR-014-12's attribution needs no snapshot.
   */
  it('withholds Patrimônio’s figure at wallet scope, where Proventos still answers', async () => {
    const { patrimonio, proventos } = await reports('wallet');

    expect(patrimonio.decomposition.kind).toBe('unavailable');
    expect(proventos.total.toString()).toBe('175');
  });
});
