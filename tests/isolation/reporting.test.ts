import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { UserId, WalletId, type AssetId, type InstitutionId } from '@/core/shared/ids';
import { runReportQuery } from '@/core/reporting/base-query';
import {
  defaultGroupLabeller,
  exportGroupedCsv,
  type CsvLabels,
} from '@/core/reporting/export-csv';
import { GROUPINGS, type Grouping, type Scope } from '@/core/reporting/ports';
import { withReportPort } from '@/app/(app)/reports/data';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { seedAsset, seedInstitution } from '../support/ledger-fixtures';
import { resetLedger, resetUsers, resetWallets } from '../support/reset';
import { seedUser } from '../support/users';

/**
 * TS-14/TS-15 — tenant isolation **at the report surface**, which is where it
 * actually matters.
 *
 * SPEC-003 DL-003-03 is explicit that leaks happen in aggregates, exports and
 * caches — above where a repository test looks. A report is the densest
 * aggregate this product builds: one number summarising somebody's entire
 * *patrimônio*. A missing tenant predicate here does not produce a visible
 * row belonging to a stranger; it produces a **total that is too large**,
 * which looks like a working report and would never be reported as a bug.
 *
 * So this asserts more than "B's rows are absent": it asserts A's totals are
 * *exactly* A's, across every scope × grouping combination and through the
 * CSV export as well.
 */
describe('SPEC-011 — report surface tenant isolation', () => {
  let database: TestDatabase;
  let migratorPool: Pool;

  const userA = UserId.generate();
  const userB = UserId.generate();
  const TODAY = BusinessDate.of('2026-08-14');

  let petr: AssetId;
  let vale: AssetId;
  let xp: InstitutionId;
  const walletA = WalletId.generate();
  const walletB = WalletId.generate();

  async function cleanUp(): Promise<void> {
    await resetWallets(database.migrationUrl);
    await resetLedger(database.migrationUrl);
    await resetUsers(database.migrationUrl);
  }

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.migrationUrl);
    // TS-03: CI shares one Postgres across suite files.
    await cleanUp();
    await seedUser(database.migrationUrl, userA);
    await seedUser(database.migrationUrl, userB);

    petr = (await seedAsset(database.migrationUrl, 'PETR4', 'Petrobras PN')).id;
    vale = (await seedAsset(database.migrationUrl, 'VALE3', 'Vale ON')).id;
    xp = await seedInstitution(database.migrationUrl, 'XP');

    migratorPool = new Pool({ connectionString: database.migrationUrl, max: 4 });

    // A holds PETR4 worth 100. B holds VALE3 worth 999999 — a figure large
    // enough that any leak changes A's total unmistakably.
    await migratorPool.query(`INSERT INTO wallets (id, user_id, name) VALUES ($1, $2, $3)`, [
      walletA,
      userA,
      'Carteira A',
    ]);
    await migratorPool.query(`INSERT INTO wallets (id, user_id, name) VALUES ($1, $2, $3)`, [
      walletB,
      userB,
      'Carteira B',
    ]);

    // `average_cost` is stated per row rather than hardcoded to 10, because
    // the report now values holdings as quantity × average cost when nothing
    // can price them (SPEC-009's COST_FALLBACK) instead of reading
    // `total_cost` directly. The old fixture set B to 50 × 10 with a
    // `total_cost` of 999999 — a row SPEC-007 could never produce, and one
    // whose inconsistency only stayed invisible because the column the report
    // read was the one that had been set by hand.
    for (const [userId, assetId, quantity, averageCost, total] of [
      [userA, petr, '10', '10', '100'],
      [userB, vale, '50', '19999.98', '999999'],
    ] as const) {
      await migratorPool.query(
        `INSERT INTO positions (id, user_id, asset_id, institution_id, quantity, average_cost, total_cost, realized_gain)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 0)`,
        [userId, assetId, xp, quantity, averageCost, total],
      );
    }

    for (const [userId, walletId, assetId, quantity] of [
      [userA, walletA, petr, '10'],
      [userB, walletB, vale, '50'],
    ] as const) {
      await migratorPool.query(
        `INSERT INTO wallet_allocations (id, user_id, wallet_id, asset_id, quantity)
         VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
        [userId, walletId, assetId, quantity],
      );
    }

    for (const [userId, total] of [
      [userA, '100'],
      [userB, '999999'],
    ] as const) {
      await migratorPool.query(
        `INSERT INTO daily_valuation_snapshots (user_id, date, total_value, net_contributions, earnings_to_date, by_asset_class)
         VALUES ($1, '2026-05-05', $2, 0, 0, '{}'::jsonb)`,
        [userId, total],
      );
    }
  }, 180_000);

  afterAll(async () => {
    await migratorPool?.end();
    // TS-03: leave the shared database as this file found it, so whichever
    // suite runs next is not reading these two tenants.
    await cleanUp();
    await database.stop();
  });

  const runAs = (userId: UserId, grouping: Grouping, scope: Scope) =>
    withReportPort(userId, async (port) =>
      // 24m, not 'all': with no `earliest` anchor 'all' collapses to the
      // single day `today` (period.ts), which would exclude the seeded
      // snapshot and make this file assert isolation over an empty range.
      runReportQuery(port, { period: { kind: '24m' }, scope, grouping, today: TODAY }, null),
    );

  it("A's portfolio total is exactly A's, under every grouping", async () => {
    for (const grouping of GROUPINGS) {
      const result = await runAs(userA, grouping, { kind: 'portfolio' });
      expect(result.ok, grouping).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      // A leak would show as 1000099, not as a visible stranger's row.
      expect(result.value.report.total.value.toString(), grouping).toBe('100');
      const holdings = result.value.report.groups.flatMap((group) => group.holdings);
      expect(
        holdings.every((holding) => holding.assetId === petr),
        grouping,
      ).toBe(true);
      expect(
        holdings.some((holding) => holding.assetId === vale),
        grouping,
      ).toBe(false);
    }
  });

  it("B's portfolio total is exactly B's", async () => {
    const result = await runAs(userB, 'asset', { kind: 'portfolio' });
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.report.total.value.toString()).toBe('999999');
  });

  it("A cannot scope a report to B's wallet, even with the correct id", async () => {
    // TS-17: supplying another tenant's id returns the caller's own view of
    // reality — here, "that wallet does not exist" — rather than B's data.
    const result = await runAs(userA, 'asset', { kind: 'wallet', walletId: walletB });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('REPORTING_WALLET_NOT_FOUND');
  });

  it("A's wallet listing never names B's wallet", async () => {
    const wallets = await withReportPort(userA, (port) => port.listWallets());
    expect(wallets.map((wallet) => wallet.name)).toEqual(['Carteira A']);
  });

  it("A's snapshot series never includes B's rows", async () => {
    const result = await runAs(userA, 'asset_class', { kind: 'portfolio' });
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.snapshots).toHaveLength(1);
    expect(result.value.snapshots[0]!.totalValue.toString()).toBe('100');
  });

  it("the CSV export carries none of B's data", async () => {
    // TS-14 names exports specifically: an export is a read path that bypasses
    // every screen a reviewer would look at.
    const labels: CsvLabels = {
      group: 'Grupo',
      assetCode: 'Ativo',
      assetName: 'Nome',
      quantity: 'Quantidade',
      value: 'Valor',
      costBasis: 'Custo',
      estimated: 'Estimado',
      unassigned: 'Não atribuído',
      notClassified: 'Não classificado',
      yes: 'Sim',
      no: 'Não',
      total: 'Total',
    };
    const result = await runAs(userA, 'wallet', { kind: 'portfolio' });
    if (!result.ok) throw new Error('unreachable');
    const csv = exportGroupedCsv(
      result.value.report,
      labels,
      defaultGroupLabeller(labels, new Map([[walletA as string, 'Carteira A']])),
    );

    expect(csv).toContain('PETR4');
    expect(csv).not.toContain('VALE3');
    expect(csv).not.toContain('Carteira B');
    expect(csv).not.toContain('999999');
  });

  it('a report read outside withTenant fails rather than returning everything', async () => {
    // TS-16 / AR-11. On a connection that has never called
    // set_config('app.user_id', ...), Postgres has no placeholder for the GUC,
    // so the policy's current_setting raises rather than resolving to
    // something permissive. Failing closed is stronger than returning zero
    // rows, and it is what makes a forgotten `withTenant` impossible to miss.
    const freshPool = new Pool({ connectionString: database.appUrl, max: 1 });
    try {
      await expect(freshPool.query('SELECT * FROM positions')).rejects.toThrow(
        /unrecognized configuration parameter.*app\.user_id/i,
      );
      await expect(freshPool.query('SELECT * FROM daily_valuation_snapshots')).rejects.toThrow(
        /unrecognized configuration parameter.*app\.user_id/i,
      );
    } finally {
      await freshPool.end();
    }
  });
});
