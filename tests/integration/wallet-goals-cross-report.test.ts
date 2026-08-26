import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as schema from '@/db/schema';
import { BusinessDate, SystemClock } from '@/core/shared/clock';
import { ConsentId, TransactionId, UserId, WalletId, type AssetId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { computeTotalValue, type TransactionType } from '@/core/ledger/transaction';
import { createTransaction } from '@/core/ledger/create-transaction';
import { deleteWallet } from '@/core/wallets/delete-wallet';
import { createGoal, updateGoal } from '@/core/goals/goal';
import { runReportQuery } from '@/core/reporting/base-query';
import { buildEarningsReport } from '@/core/reporting/earnings/report';
import { DrizzleAssetCatalogRepository } from '@/adapters/db/asset-catalog-repository';
import { DrizzleConsentRepository } from '@/adapters/db/consent-repository';
import { DrizzlePositionRepository } from '@/adapters/db/position-repository';
import { DrizzleQuoteRepository } from '@/adapters/db/quote-repository';
import { DrizzleTransactionRepository } from '@/adapters/db/transaction-repository';
import { DrizzleWalletGoalRepository } from '@/adapters/db/wallet-goal-repository';
import { LogGoalNotificationAdapter } from '@/adapters/notifications/log-goal-notification-adapter';
import { DrizzleReportDataPort } from '@/app/(app)/reports/data';
import { loadGoalsView } from '@/app/(app)/wallets/goals-data';
import { withGoalDeps } from '@/app/(app)/wallets/goals-composition';
import { withWalletDeps } from '@/app/(app)/wallets/composition';
import { withTenant } from '@/db/tenant';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetConsents, resetLedger, resetUsers, resetWallets } from '../support/reset';
import { seedUser } from '../support/users';

/**
 * SPEC-019 — the two cross-report acceptance criteria (AC-3, AC-13), the
 * year-boundary rules (BR-019-19/20/21), the amount-edit isolation
 * (BR-019-27), the deletion cascade (BR-019-08) and the achievement
 * notification (BR-019-25) — all against real Postgres, in the shape of
 * `tests/integration/earnings-cross-report.test.ts`.
 *
 * TS-04: every expected figure below is hand-computed from the seeded rows,
 * never read from `loadGoalsView`'s own output. TS-03: every table this file
 * touches is truncated in both `beforeAll` and `afterAll`, and every id is
 * generated fresh, so the suite is order-agnostic on a database shared with
 * every other integration file.
 */
describe('SPEC-019 — wallet goals, proven against real Postgres', () => {
  let database: TestDatabase;
  let appPool: Pool;
  let migratorPool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  const userId = UserId.generate();
  const clock = new SystemClock();
  const today = clock.today();
  const currentYear = Number(today.slice(0, 4));
  const pastYear = currentYear - 1;
  const emptyYear = currentYear - 2;

  const mainWalletId = WalletId.generate();
  const listedNullWalletId = WalletId.generate();
  const cdbNullWalletId = WalletId.generate();
  const raiseWalletId = WalletId.generate();
  const deleteTargetWalletId = WalletId.generate();
  const achievementWalletId = WalletId.generate();

  let petr: AssetId;
  let cdb: AssetId;
  let vale: AssetId;
  let achieveAsset: AssetId;
  let raiseAsset: AssetId;

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.migrationUrl);

    appPool = new Pool({ connectionString: database.appUrl, max: 5 });
    migratorPool = new Pool({ connectionString: database.migrationUrl, max: 1 });
    db = drizzle(appPool, { schema });

    // TS-03: CI shares one Postgres across suites.
    await migratorPool.query('TRUNCATE price_quotes, latest_quotes CASCADE');
    await resetWallets(database.migrationUrl);
    await resetLedger(database.migrationUrl);
    await resetConsents(database.migrationUrl);
    await resetUsers(database.migrationUrl);
    await seedUser(database.migrationUrl, userId);

    const catalog = new DrizzleAssetCatalogRepository(db);
    petr = (
      await catalog.upsertByCode({ code: 'PETR4-GOALS', name: 'Petrobras PN', assetClass: 'stock' })
    ).id;
    cdb = (
      await catalog.upsertByCode({ code: 'CDB-GOALS', name: 'CDB Banco Teste', assetClass: 'cdb' })
    ).id;
    vale = (
      await catalog.upsertByCode({ code: 'VALE3-GOALS', name: 'Vale ON', assetClass: 'stock' })
    ).id;
    achieveAsset = (
      await catalog.upsertByCode({
        code: 'ACHV-GOALS',
        name: 'Achievement Co',
        assetClass: 'stock',
      })
    ).id;
    // Dedicated to the invested-basis "raise the amount" wallet (BR-019-27):
    // that wallet must not also hold PETR4, or SPEC-014's attribution would
    // split PETR4's dividends across both wallets and corrupt AC-13's total —
    // exactly the dilution this file's own comment on the achievement wallet
    // warns about, discovered the hard way while writing this fixture.
    raiseAsset = (
      await catalog.upsertByCode({ code: 'RAISE-GOALS', name: 'Reajuste SA', assetClass: 'stock' })
    ).id;

    // The two live prices this file needs: `today`'s quote for PETR4 (read by
    // the main wallet's `current_value` goal and by the Portfolio Value
    // comparison, AC-3) and for VALE3 (read by the listed/no-cost wallet's
    // `current_value` goal, §1) — both resolve `mode: 'current'` for
    // `asOf === today` and both read `latest_quotes`.
    const quotes = new DrizzleQuoteRepository(db);
    await quotes.upsertLatestQuote({
      assetId: petr,
      price: Money.fromString('40'),
      quotedAt: new Date(),
      fetchedAt: new Date(),
      source: 'brapi_free',
    });
    await quotes.upsertLatestQuote({
      assetId: vale,
      price: Money.fromString('40'),
      quotedAt: new Date(),
      fetchedAt: new Date(),
      source: 'brapi_free',
    });

    // --- Main wallet: a real ledger buy, so the position cache and
    // `wallet_allocations` exist for AC-3's Portfolio Value comparison, plus
    // the allocation-event mirror `core/goals` reads from. Both must agree —
    // that agreement is BR-010-22's whole point.
    await withTenant(
      userId,
      async (tx) => {
        await createTransaction(
          {
            transactions: new DrizzleTransactionRepository(tx, userId),
            positions: new DrizzlePositionRepository(tx, userId),
            clock,
          },
          userId,
          {
            assetId: petr,
            institutionId: null,
            type: 'buy',
            tradeDate: BusinessDate.of(`${emptyYear}-02-01`),
            quantity: Quantity.fromString('100'),
            unitPrice: Money.fromString('30'),
            fees: Money.zero(),
          },
        );

        await tx.insert(schema.wallets).values({
          id: mainWalletId,
          userId,
          name: 'Carteira Principal',
          description: null,
          goal: null,
          color: null,
        });
        await tx.insert(schema.walletAllocationEvents).values({
          id: TransactionId.generate(),
          userId,
          walletId: mainWalletId,
          assetId: petr,
          quantity: Quantity.fromString('100'),
          costBasisAfter: Money.fromString('3000'),
          effectiveOn: BusinessDate.of(`${emptyYear}-02-01`),
          cause: 'buy',
        });
        await tx.insert(schema.walletAllocations).values({
          id: TransactionId.generate(),
          userId,
          walletId: mainWalletId,
          assetId: petr,
          quantity: Quantity.fromString('100'),
          costBasisAtAllocation: Money.fromString('3000'),
          allocatedAt: new Date(),
        });
      },
      db,
    );

    // --- Earnings, raw-inserted exactly as `earnings-cross-report.test.ts`
    // does — attribution needs only `transactions`, never a use case.
    //  - `pastYear` (closed): one payment, for BR-019-20/AC-11.
    //  - `currentYear`: one legitimate January payment (guaranteed elapsed —
    //    January has always begun by the time `today` falls in this year),
    //    plus two payments dated either side of the year boundary, for
    //    BR-019-19/AC-8.
    //  - `emptyYear`: nothing at all, for BR-019-21/AC-12 — the wallet held
    //    PETR4 throughout (the buy above predates it) but received no income.
    await seedEarning(petr, 'dividend', `${pastYear}-06-15`, '100', '0.45');
    await seedEarning(petr, 'dividend', `${currentYear}-01-15`, '100', '0.50');
    await seedEarning(petr, 'dividend', `${pastYear}-12-31`, '100', '9.99');
    await seedEarning(petr, 'dividend', `${currentYear + 1}-01-01`, '100', '8.88');

    // --- The two lightweight wallets that prove §1's class split. Neither
    // needs a real ledger transaction or a `positions` row: `core/goals`
    // prices a wallet purely from `wallet_allocation_events`. The listed one
    // holds VALE3, not PETR4 — PETR4 is the main wallet's own asset and
    // sharing it here would dilute SPEC-014's earnings attribution for the
    // main wallet's dividends (discovered the hard way; see the comment on
    // `raiseAsset` above).
    await withTenant(
      userId,
      async (tx) => {
        await tx.insert(schema.wallets).values([
          {
            id: listedNullWalletId,
            userId,
            name: 'Listada sem custo',
            description: null,
            goal: null,
            color: null,
          },
          {
            id: cdbNullWalletId,
            userId,
            name: 'Renda fixa sem custo',
            description: null,
            goal: null,
            color: null,
          },
        ]);
        await tx.insert(schema.walletAllocationEvents).values([
          {
            id: TransactionId.generate(),
            userId,
            walletId: listedNullWalletId,
            assetId: vale,
            quantity: Quantity.fromString('10'),
            costBasisAfter: null,
            effectiveOn: BusinessDate.of(`${pastYear}-01-01`),
            cause: 'backfill',
          },
          {
            id: TransactionId.generate(),
            userId,
            walletId: cdbNullWalletId,
            assetId: cdb,
            quantity: Quantity.fromString('5'),
            costBasisAfter: null,
            effectiveOn: BusinessDate.of(`${pastYear}-01-01`),
            cause: 'backfill',
          },
        ]);
      },
      db,
    );
    await withGoalDeps(userId, (deps) =>
      createGoal(deps, userId, {
        walletId: listedNullWalletId,
        name: 'Meta listada',
        kind: 'growth',
        amount: Money.fromString('1'),
        basis: 'current_value',
      }),
    );
    await withGoalDeps(userId, (deps) =>
      createGoal(deps, userId, {
        walletId: cdbNullWalletId,
        name: 'Meta renda fixa',
        kind: 'growth',
        amount: Money.fromString('1'),
        basis: 'current_value',
      }),
    );

    // --- The two goals under test on the main wallet.
    await withGoalDeps(userId, (deps) =>
      createGoal(deps, userId, {
        walletId: mainWalletId,
        name: 'Crescer a mercado',
        kind: 'growth',
        amount: Money.fromString('100000'),
        basis: 'current_value',
      }),
    );
    await withGoalDeps(userId, (deps) =>
      createGoal(deps, userId, {
        walletId: mainWalletId,
        name: 'Proventos do ano',
        kind: 'earnings',
        amount: Money.fromString('40'),
        period: 'yearly',
      }),
    );

    // --- BR-019-27/AC-16: a wallet whose invested-basis series must survive
    // an amount edit unchanged. No price data needed at all.
    await withTenant(
      userId,
      async (tx) => {
        await tx.insert(schema.wallets).values({
          id: raiseWalletId,
          userId,
          name: 'Carteira do reajuste',
          description: null,
          goal: null,
          color: null,
        });
        await tx.insert(schema.walletAllocationEvents).values({
          id: TransactionId.generate(),
          userId,
          walletId: raiseWalletId,
          assetId: raiseAsset,
          quantity: Quantity.fromString('20'),
          costBasisAfter: Money.fromString('2000'),
          effectiveOn: BusinessDate.of(`${emptyYear}-01-01`),
          cause: 'buy',
        });
      },
      db,
    );
    await withGoalDeps(userId, (deps) =>
      createGoal(deps, userId, {
        walletId: raiseWalletId,
        name: 'Meta reajustável',
        kind: 'growth',
        amount: Money.fromString('500'),
        basis: 'invested',
      }),
    );

    // --- BR-019-08/AC-17: a wallet with a real transaction, to be deleted.
    await withTenant(
      userId,
      async (tx) => {
        await createTransaction(
          {
            transactions: new DrizzleTransactionRepository(tx, userId),
            positions: new DrizzlePositionRepository(tx, userId),
            clock,
          },
          userId,
          {
            assetId: vale,
            institutionId: null,
            type: 'buy',
            tradeDate: BusinessDate.of(`${emptyYear}-03-01`),
            quantity: Quantity.fromString('10'),
            unitPrice: Money.fromString('50'),
            fees: Money.zero(),
          },
        );
        await tx.insert(schema.wallets).values({
          id: deleteTargetWalletId,
          userId,
          name: 'Carteira a apagar',
          description: null,
          goal: null,
          color: null,
        });
        await tx.insert(schema.walletAllocationEvents).values({
          id: TransactionId.generate(),
          userId,
          walletId: deleteTargetWalletId,
          assetId: vale,
          quantity: Quantity.fromString('10'),
          costBasisAfter: Money.fromString('500'),
          effectiveOn: BusinessDate.of(`${emptyYear}-03-01`),
          cause: 'buy',
        });
      },
      db,
    );
    await withGoalDeps(userId, (deps) =>
      createGoal(deps, userId, {
        walletId: deleteTargetWalletId,
        name: 'Meta a apagar',
        kind: 'growth',
        amount: Money.fromString('1'),
        basis: 'invested',
      }),
    );

    // --- BR-019-25/AC-14: an isolated wallet + asset, so this payment's
    // attribution cannot be diluted by any other wallet holding the same
    // asset (see the comment at the seeding call for why a shared asset would
    // muddy the arithmetic).
    await withTenant(
      userId,
      async (tx) => {
        await tx.insert(schema.wallets).values({
          id: achievementWalletId,
          userId,
          name: 'Carteira da conquista',
          description: null,
          goal: null,
          color: null,
        });
        await tx.insert(schema.walletAllocationEvents).values({
          id: TransactionId.generate(),
          userId,
          walletId: achievementWalletId,
          assetId: achieveAsset,
          quantity: Quantity.fromString('100'),
          costBasisAfter: null,
          effectiveOn: BusinessDate.of(`${emptyYear}-01-01`),
          cause: 'buy',
        });
      },
      db,
    );
    await seedEarning(achieveAsset, 'dividend', today, '100', '0.50');
    await withGoalDeps(userId, (deps) =>
      createGoal(deps, userId, {
        walletId: achievementWalletId,
        name: 'Meta de renda mensal',
        kind: 'earnings',
        amount: Money.fromString('40'),
        period: 'monthly',
      }),
    );
    await withTenant(
      userId,
      (tx) =>
        new DrizzleConsentRepository(tx, userId).upsert({
          id: ConsentId.generate(),
          userId,
          purpose: 'email_reminders',
          grantedAt: new Date(),
          revokedAt: null,
          policyVersion: '1.0',
        }),
      db,
    );
  }, 300_000);

  afterAll(async () => {
    await resetWallets(database.migrationUrl);
    await resetLedger(database.migrationUrl);
    await resetConsents(database.migrationUrl);
    await resetUsers(database.migrationUrl);
    await migratorPool.query('TRUNCATE price_quotes, latest_quotes CASCADE');
    await appPool.end();
    await migratorPool.end();
    await database.stop();
  });

  let sequence = 0;
  async function seedEarning(
    assetId: AssetId,
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
        assetId,
        type,
        tradeDate,
        q.toString(),
        price.toString(),
        computeTotalValue(type, q, price, Money.zero()).toString(),
        `goals|${tradeDate}|${type}|${sequence}`,
      ],
    );
  }

  async function reportPortfolioCurrentValue(walletId: WalletId): Promise<Money> {
    return withTenant(
      userId,
      async (tx) => {
        const port = new DrizzleReportDataPort(tx, userId, clock);
        const result = await runReportQuery(
          port,
          {
            period: { kind: 'custom', from: today, to: today },
            scope: { kind: 'wallet', walletId },
            grouping: 'asset_class',
            today,
          },
          await port.earliestSnapshotDate(),
        );
        if (!result.ok) throw new Error(`query failed: ${result.error.code}`);
        return result.value.report.total.value;
      },
      db,
    );
  }

  async function earningsReportTotal(walletId: WalletId, year: number): Promise<Money> {
    return withTenant(
      userId,
      async (tx) => {
        const port = new DrizzleReportDataPort(tx, userId, clock);
        const from = BusinessDate.of(`${year}-01-01`);
        const to = BusinessDate.of(`${year}-12-31`);
        const result = await runReportQuery(
          port,
          {
            period: { kind: 'custom', from, to },
            scope: { kind: 'wallet', walletId },
            grouping: 'asset_class',
            today,
          },
          await port.earliestSnapshotDate(),
        );
        if (!result.ok) throw new Error(`query failed: ${result.error.code}`);

        const [earnings, trailing, previous, events] = await Promise.all([
          port.listEarnings(from, to),
          port.listEarnings(BusinessDate.of(`${year - 1}-01-01`), to),
          port.listEarnings(
            BusinessDate.of(`${year - 2}-01-01`),
            BusinessDate.of(`${year - 1}-12-31`),
          ),
          port.listAllocationEvents(to),
        ]);
        const assetIds = [...new Set(earnings.map((earning) => earning.assetId))];
        const descriptors = assetIds.length === 0 ? [] : await port.describeAssets(assetIds);

        const report = buildEarningsReport({
          query: result.value,
          earnings,
          trailing,
          previous,
          allocationEvents: events,
          descriptors,
        });
        return report.total;
      },
      db,
    );
  }

  function growthGoal(view: NonNullable<Awaited<ReturnType<typeof loadGoalsView>>>) {
    const found = view.goals.find((g) => g.growth !== null);
    if (found === undefined) throw new Error('no growth goal in view');
    return found;
  }

  function earningsGoal(view: NonNullable<Awaited<ReturnType<typeof loadGoalsView>>>) {
    const found = view.goals.find((g) => g.earnings !== null);
    if (found === undefined) throw new Error('no earnings goal in view');
    return found;
  }

  it("AC-3: a current_value goal's current figure equals the wallet's Portfolio Value for the same date", async () => {
    const view = await loadGoalsView(userId, mainWalletId, null);
    if (view === null) throw new Error('expected the wallet to load');

    const goal = growthGoal(view);
    const current = goal.growth?.current;
    if (current === null || current === undefined || current.kind !== 'available') {
      throw new Error('expected an available current-value point');
    }

    const reportValue = await reportPortfolioCurrentValue(mainWalletId);
    // Hand-computed: 100 PETR4 × R$ 40,00 = R$ 4.000,00. Asserted directly
    // (TS-04), and then cross-checked against the independent report path.
    expect(current.value.toString()).toBe('4000');
    expect(current.value.equals(reportValue)).toBe(true);
  });

  it("AC-13: the selected year's total equals the Earnings report's total for the same wallet and year", async () => {
    const view = await loadGoalsView(userId, mainWalletId, currentYear);
    if (view === null) throw new Error('expected the wallet to load');

    const goal = earningsGoal(view);
    // Hand-computed: only the `${currentYear}-01-15` payment (100 × 0,50 =
    // 50) belongs to `currentYear` — both boundary payments belong to a
    // different calendar year and must not contribute (BR-019-19).
    expect(goal.earnings?.total.toString()).toBe('50');

    const reportTotal = await earningsReportTotal(mainWalletId, currentYear);
    expect(goal.earnings?.total.equals(reportTotal)).toBe(true);
  });

  it('BR-019-19/AC-8: no earnings figure references a month outside the selected year', async () => {
    const view = await loadGoalsView(userId, mainWalletId, currentYear);
    if (view === null) throw new Error('expected the wallet to load');
    const goal = earningsGoal(view);
    const progress = goal.earnings;
    if (progress === null || progress === undefined) throw new Error('expected earnings progress');

    // The two boundary payments (999 → 9,99 × 100 and 888 → 8,88 × 100) must
    // appear nowhere: not in the total, not in any month, not in the highlight.
    expect(progress.total.toString()).toBe('50');
    for (const month of progress.months) {
      if (month.kind === 'elapsed') {
        expect(month.amount.toString()).not.toBe('999');
        expect(month.amount.toString()).not.toBe('888');
        expect(month.cumulative.toString()).not.toBe('999');
        expect(month.cumulative.toString()).not.toBe('888');
      }
    }
    expect(progress.highlight.amount.toString()).not.toBe('999');
    expect(progress.highlight.amount.toString()).not.toBe('888');
  });

  it("BR-019-20/AC-11: viewing a closed year shows that year's total in place of the current month", async () => {
    const view = await loadGoalsView(userId, mainWalletId, pastYear);
    if (view === null) throw new Error('expected the wallet to load');
    const goal = earningsGoal(view);
    const progress = goal.earnings;
    if (progress === null || progress === undefined) throw new Error('expected earnings progress');

    // Hand-computed: `pastYear`'s two payments — 06-15 (100 × 0,45 = 45) and
    // 12-31 (100 × 9,99 = 999) both belong to `pastYear` itself.
    expect(progress.total.toString()).toBe('1044');
    expect(progress.highlight.kind).toBe('year_total');
    if (progress.highlight.kind === 'year_total') {
      expect(progress.highlight.year).toBe(pastYear);
      expect(progress.highlight.amount.toString()).toBe('1044');
    }
  });

  it('BR-019-21/AC-12: a year the wallet held assets that paid nothing renders empty', async () => {
    const view = await loadGoalsView(userId, mainWalletId, emptyYear);
    if (view === null) throw new Error('expected the wallet to load');
    expect(view.years).toContain(emptyYear);

    const goal = earningsGoal(view);
    const progress = goal.earnings;
    if (progress === null || progress === undefined) throw new Error('expected earnings progress');

    expect(progress.empty).toBe(true);
    expect(progress.months).toEqual([]);
    expect(progress.total.toString()).toBe('0');
  });

  it('the current-value line prices a listed holding with no recorded cost, and refuses a fixed-income one', async () => {
    const listedView = await loadGoalsView(userId, listedNullWalletId, null);
    if (listedView === null) throw new Error('expected the wallet to load');
    const listedCurrent = growthGoal(listedView).growth?.current;
    if (listedCurrent === null || listedCurrent === undefined) {
      throw new Error('expected a current point');
    }
    // 10 PETR4 × R$ 40,00 = R$ 400,00 — the cost basis was never an input.
    expect(listedCurrent.kind).toBe('available');
    if (listedCurrent.kind === 'available') expect(listedCurrent.value.toString()).toBe('400');

    const cdbView = await loadGoalsView(userId, cdbNullWalletId, null);
    if (cdbView === null) throw new Error('expected the wallet to load');
    const cdbCurrent = growthGoal(cdbView).growth?.current;
    if (cdbCurrent === null || cdbCurrent === undefined)
      throw new Error('expected a current point');
    expect(cdbCurrent.kind).toBe('unavailable');
    if (cdbCurrent.kind === 'unavailable') {
      expect(cdbCurrent.reason).toBe('COST_BASIS_NOT_RECORDED');
    }
  });

  /**
   * The hole the class split left, and the one that would have shipped
   * quietly.
   *
   * "A listed holding needs no cost, because value is quantity × price" is
   * true only where a price exists. Where none does, `valueListed` falls back
   * to `averageCost × quantity` (BR-009-13's cost floor) — and the adapter had
   * substituted **zero** for the unrecorded cost, so the floor became zero and
   * came back as a real figure. Every sampled date before quote coverage would
   * have drawn at R$ 0,00 with the accessibility table calling it "Estimado".
   *
   * That is the whole burn-up for the product's normal onboarding path: import
   * years of B3 extracts, whose allocation events predate this migration and
   * therefore carry no cost, and whose historical dates predate any quote this
   * installation ever synced.
   */
  it('never draws a listed holding at R$ 0,00 when it has neither a price nor a recorded cost', async () => {
    const view = await loadGoalsView(userId, listedNullWalletId, null);
    if (view === null) throw new Error('expected the wallet to load');
    const series = growthGoal(view).growth?.series ?? [];
    expect(series.length).toBeGreaterThan(1);

    // Not one available point may be zero. A zero here is the defect.
    const zeroes = series.filter((point) => point.kind === 'available' && point.value.isZero());
    expect(zeroes).toHaveLength(0);

    // The dates with no close are refused, and refused for the right reason —
    // not "cost not recorded", which would send the user looking for a cost
    // they cannot supply, but "no price and no cost to fall back to".
    const refused = series.filter((point) => point.kind === 'unavailable');
    expect(refused.length).toBeGreaterThan(0);
    for (const point of refused) {
      if (point.kind !== 'unavailable') continue;
      expect(point.reason).toBe('PRICE_UNAVAILABLE');
    }
  });

  /**
   * BR-019-23 with BR-019-26 — **the year selector is a browsing control, and
   * browsing must not write.**
   *
   * An earnings goal is achieved within the period it names, which is the one
   * running now. Feeding the *displayed* year's verdict into the achievement
   * write meant opening the dropdown, picking a year in which the wallet had
   * once been paid, and permanently marking the goal — the marker is never
   * cleared — stamped with today's date, plus an email. A question about the
   * past, answered by writing to the database and mailing the user.
   */
  it('BR-019-23: viewing a closed year never marks an earnings goal achieved', async () => {
    // TS-03: asserted as "unchanged by this read" rather than as "null", so
    // the test does not depend on whether some earlier file or case in this
    // one has already viewed the current year and legitimately marked it.
    const goalId = earningsGoal(
      (await loadGoalsView(userId, mainWalletId, null)) ??
        (() => {
          throw new Error('expected the wallet to load');
        })(),
    ).goal.id;

    const readMarker = async (): Promise<BusinessDate | null> =>
      (
        await withTenant(
          userId,
          (tx) => new DrizzleWalletGoalRepository(tx, userId).findById(goalId),
          db,
        )
      )?.achievedOn ?? null;

    const before = await readMarker();

    const closedYear = await loadGoalsView(userId, mainWalletId, pastYear);
    if (closedYear === null) throw new Error('expected the wallet to load');
    const viewed = earningsGoal(closedYear);

    // The closed year's own figures are shown — that is what the selector is
    // for — and `pastYear`'s R$ 1.044,00 clears the R$ 40,00 goal inside it…
    expect(viewed.earnings?.year).toBe(pastYear);
    expect(viewed.earnings?.achieved).toBe(true);

    // …and viewing it wrote nothing. Before the fix this read marked the goal
    // permanently and sent the achievement email.
    expect(await readMarker()).toEqual(before);
  });

  it('BR-019-27/AC-16: raising the goal amount leaves every historical point on the real line identical', async () => {
    const before = await loadGoalsView(userId, raiseWalletId, null);
    if (before === null) throw new Error('expected the wallet to load');
    const goalBefore = growthGoal(before);
    const seriesBefore = goalBefore.growth?.series ?? [];
    expect(seriesBefore.length).toBeGreaterThan(0);

    await withGoalDeps(userId, (deps) =>
      updateGoal(deps, userId, { goalId: goalBefore.goal.id, amount: Money.fromString('999999') }),
    );

    const after = await loadGoalsView(userId, raiseWalletId, null);
    if (after === null) throw new Error('expected the wallet to load');
    const goalAfter = growthGoal(after);
    const seriesAfter = goalAfter.growth?.series ?? [];

    expect(seriesAfter.length).toBe(seriesBefore.length);
    for (let i = 0; i < seriesBefore.length; i += 1) {
      const a = seriesBefore[i];
      const b = seriesAfter[i];
      if (a === undefined || b === undefined) throw new Error('index out of range');
      expect(a.kind).toBe(b.kind);
      expect(a.date).toBe(b.date);
      if (a.kind === 'available' && b.kind === 'available') {
        expect(a.value.equals(b.value)).toBe(true);
      }
    }
    expect(goalAfter.goal.amount.toString()).toBe('999999');
  });

  it('BR-019-08/AC-17: deleting the wallet deletes its goals and leaves every transactions row intact', async () => {
    const before = await withTenant(
      userId,
      (tx) => new DrizzleWalletGoalRepository(tx, userId).listForWallet(deleteTargetWalletId),
      db,
    );
    expect(before.length).toBe(1);

    const transactionsBeforeRow = (
      await migratorPool.query<{ count: string }>('SELECT count(*)::int AS count FROM transactions')
    ).rows[0];
    if (transactionsBeforeRow === undefined) throw new Error('expected a count row');
    const transactionsBefore = transactionsBeforeRow.count;

    const result = await withWalletDeps(userId, (deps) =>
      deleteWallet(deps, userId, deleteTargetWalletId),
    );
    if (!result.ok) throw new Error(`delete failed: ${result.error.code}`);

    const after = await withTenant(
      userId,
      (tx) => new DrizzleWalletGoalRepository(tx, userId).listForWallet(deleteTargetWalletId),
      db,
    );
    expect(after.length).toBe(0);

    const transactionsAfterRow = (
      await migratorPool.query<{ count: string }>('SELECT count(*)::int AS count FROM transactions')
    ).rows[0];
    if (transactionsAfterRow === undefined) throw new Error('expected a count row');
    expect(transactionsAfterRow.count).toBe(transactionsBefore);
  });

  /**
   * By the time this test runs, every earlier `it` above has already called
   * `loadGoalsView` on the main/raise/listed-null wallets at least once, and
   * three of those goals cross their own amount incidentally (the main
   * wallet's yearly earnings goal, and the two lightweight growth goals whose
   * amount is a token `R$ 1`) — so their `achieved_on` is already set before
   * this test's spy is installed, and re-reading them here (as several tests
   * above already do) sends nothing more. That is BR-019-24/25 holding for
   * every goal in this fixture, not just the one under test; only the
   * achievement wallet's transition happens **after** the spy attaches, which
   * is what makes counting `sendSpy`'s calls from this point on a valid proof
   * of "exactly one".
   */
  it('BR-019-25/AC-14: achievement sends exactly one notification; a second evaluation sends none', async () => {
    const sendSpy = vi.spyOn(LogGoalNotificationAdapter.prototype, 'sendGoalAchieved');

    const first = await loadGoalsView(userId, achievementWalletId, currentYear);
    if (first === null) throw new Error('expected the wallet to load');
    const firstGoal = earningsGoal(first);
    expect(firstGoal.earnings?.achieved).toBe(true);
    expect(firstGoal.goal.achievedOn).not.toBeNull();
    expect(sendSpy).toHaveBeenCalledTimes(1);

    const achievedOn = firstGoal.goal.achievedOn;

    const second = await loadGoalsView(userId, achievementWalletId, currentYear);
    if (second === null) throw new Error('expected the wallet to load');
    const secondGoal = earningsGoal(second);
    // BR-019-24/26: the same date, not a later one.
    expect(secondGoal.goal.achievedOn).toBe(achievedOn);
    // BR-019-25: no second email.
    expect(sendSpy).toHaveBeenCalledTimes(1);

    sendSpy.mockRestore();
  });
});
