import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { UserId, WalletId, type AssetId, type InstitutionId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { runReportQuery, totalsOf } from '@/core/reporting/base-query';
import { defaultGroupingFor } from '@/core/reporting/grouping';
import {
  defaultGroupLabeller,
  exportGroupedCsv,
  type CsvLabels,
} from '@/core/reporting/export-csv';
import { GROUPINGS, UNASSIGNED_GROUP_ID, type Grouping } from '@/core/reporting/ports';
import { fromSearchParams, toQueryString } from '@/lib/report-url-state';
import { withReportPort } from '@/app/(app)/reports/data';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { seedAsset, seedInstitution } from '../support/ledger-fixtures';
import { resetLedger, resetUsers, resetWallets } from '../support/reset';
import { seedUser } from '../support/users';

/**
 * SPEC-011 against **real Postgres** — the reporting framework end to end,
 * through the Drizzle adapter and `withTenant` (AR-11).
 *
 * What genuinely needs a database here, rather than the fake port: the
 * `NUMERIC(20,8)` ⇄ `Decimal` round trip (TESTING §1 — where floating-point
 * corruption would enter), the RLS-scoped reads, and the fact that the
 * adapter's own SQL selects the rows the domain expects.
 *
 * TS-03: the database is shared across suite files in CI, so this file
 * truncates everything it touches in **both** `beforeAll` and `afterAll` —
 * the second half is what stops this file breaking whichever runs after it.
 */
describe('SPEC-011 reporting framework (integration)', () => {
  let database: TestDatabase;
  let migratorPool: Pool;

  const userId = UserId.generate();
  const TODAY = BusinessDate.of('2026-08-14');

  let itsa: AssetId;
  let hglg: AssetId;
  let cdb: AssetId;
  let xp: InstitutionId;
  let rico: InstitutionId;
  let retirement: WalletId;
  let income: WalletId;
  let emptyWallet: WalletId;

  async function cleanUp(): Promise<void> {
    await resetWallets(database.migrationUrl);
    await resetLedger(database.migrationUrl);
    await resetUsers(database.migrationUrl);
  }

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.migrationUrl);
    await cleanUp();
    await seedUser(database.migrationUrl, userId);

    itsa = (await seedAsset(database.migrationUrl, 'ITSA4', 'Itaúsa PN')).id;
    hglg = (await seedAsset(database.migrationUrl, 'HGLG11', 'CSHG Logística', 'fii')).id;
    cdb = (await seedAsset(database.migrationUrl, 'CDB-BANCO-X', 'CDB 110% CDI', 'cdb')).id;
    xp = await seedInstitution(database.migrationUrl, 'XP Investimentos');
    rico = await seedInstitution(database.migrationUrl, 'Rico');

    migratorPool = new Pool({ connectionString: database.migrationUrl, max: 4 });
  }, 180_000);

  afterAll(async () => {
    await migratorPool?.end();
    // TS-03: leave the shared database as this file found it.
    await cleanUp();
    await database.stop();
  });

  /**
   * The fixture, chosen to exercise every awkward path at once:
   *   ITSA4 100 units — 60 at XP, 40 at Rico, split 50 / 30 across two wallets
   *                     leaving 20 unallocated
   *   HGLG11 10 units — one institution, wholly unallocated
   *   CDB     1 unit  — NO institution and NO sector (fixed income)
   *   plus a wallet holding nothing at all.
   */
  beforeEach(async () => {
    await resetWallets(database.migrationUrl);
    await migratorPool.query('TRUNCATE positions, daily_valuation_snapshots CASCADE');

    retirement = WalletId.generate();
    income = WalletId.generate();
    emptyWallet = WalletId.generate();
    for (const [id, name] of [
      [retirement, 'Aposentadoria'],
      [income, 'Renda'],
      [emptyWallet, 'Vazia'],
    ] as const) {
      await migratorPool.query(`INSERT INTO wallets (id, user_id, name) VALUES ($1, $2, $3)`, [
        id,
        userId,
        name,
      ]);
    }

    // total_cost is what the adapter currently values a position at.
    const positionRows: readonly [AssetId, InstitutionId | null, string, string, string][] = [
      [itsa, xp, '60', '10', '600'],
      [itsa, rico, '40', '10', '400'],
      [hglg, xp, '10', '150', '1500'],
      [cdb, null, '1', '1000.55', '1000.55'],
    ];
    for (const [assetId, institutionId, quantity, averageCost, totalCost] of positionRows) {
      await migratorPool.query(
        `INSERT INTO positions (id, user_id, asset_id, institution_id, quantity, average_cost, total_cost, realized_gain)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 0)`,
        [userId, assetId, institutionId, quantity, averageCost, totalCost],
      );
    }

    for (const [walletId, assetId, quantity] of [
      [retirement, itsa, '50'],
      [income, itsa, '30'],
    ] as const) {
      await migratorPool.query(
        `INSERT INTO wallet_allocations (id, user_id, wallet_id, asset_id, quantity)
         VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
        [userId, walletId, assetId, quantity],
      );
    }

    await migratorPool.query(
      `INSERT INTO daily_valuation_snapshots (user_id, date, total_value, net_contributions, earnings_to_date, by_asset_class, has_estimates)
       VALUES ($1, $2, $3, 0, 0, $4::jsonb, true)`,
      [
        userId,
        '2026-03-02',
        '3500.55',
        JSON.stringify({ stock: '1000', fii: '1500', cdb: '1000.55' }),
      ],
    );
  });

  const query = (grouping: Grouping, scope: Parameters<typeof runReportQuery>[1]['scope']) =>
    withReportPort(userId, async (port) =>
      runReportQuery(port, { period: { kind: 'ytd' }, scope, grouping, today: TODAY }, null),
    );

  const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
    if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
    return r.value;
  };

  // Total value = 600 + 400 + 1500 + 1000.55 = 3500.55
  const TOTAL = '3500.55';

  it('reads NUMERIC(20,8) back as exact Decimal money, with no float drift', async () => {
    // TESTING §1: this is the round trip where corruption would enter. 1000.55
    // is not representable in binary floating point.
    const result = unwrap(await query('asset_class', { kind: 'portfolio' }));
    expect(result.report.total.value.toString()).toBe(TOTAL);
    const cdbGroup = result.report.groups.find((g) => g.key.id === 'cdb')!;
    expect(cdbGroup.totals.value.toString()).toBe('1000.55');
  });

  it('AC-6 — every grouping of the portfolio sums to the same total', async () => {
    for (const grouping of GROUPINGS) {
      const result = unwrap(await query(grouping, { kind: 'portfolio' }));
      expect(result.report.total.value.toString(), grouping).toBe(TOTAL);
      const summed = result.report.groups.reduce(
        (acc, group) => acc.plus(group.totals.value),
        Money.zero(),
      );
      expect(summed.toString(), `${grouping} groups`).toBe(TOTAL);
    }
  });

  it('AC-7 — grouping by wallet at portfolio scope shows Unassigned and reconciles', async () => {
    const result = unwrap(await query('wallet', { kind: 'portfolio' }));
    const byId = new Map(result.report.groups.map((g) => [g.key.id, g.totals.value.toString()]));

    // ITSA4 is worth 1000 over 100 units, so each unit is 10.
    //   Aposentadoria 50 units → 500
    //   Renda         30 units → 300
    //   Unassigned    20 units → 200, plus all of HGLG11 (1500) and the CDB
    //                  (1000.55) → 2700.55
    expect(byId.get(retirement)).toBe('500');
    expect(byId.get(income)).toBe('300');
    expect(byId.get(UNASSIGNED_GROUP_ID)).toBe('2700.55');
    // The empty wallet contributes no group at all rather than a zero row.
    expect(byId.has(emptyWallet)).toBe(false);
    expect(result.report.total.value.toString()).toBe(TOTAL);
  });

  it('AC-8 — grouping by sector with fixed income present shows Not classified', async () => {
    const result = unwrap(await query('sector', { kind: 'portfolio' }));
    // The catalog has no sector column yet (PRD Q5), so every holding lands in
    // the bucket — which is exactly the behaviour BR-011-10 specifies, and the
    // totals still reconcile.
    const notClassified = result.report.groups.find((g) => g.key.synthetic)!;
    expect(notClassified.totals.value.toString()).toBe(TOTAL);
    expect(result.report.total.value.toString()).toBe(TOTAL);
  });

  it('groups by institution, with a null institution in Not classified', async () => {
    const result = unwrap(await query('institution', { kind: 'portfolio' }));
    const byId = new Map(result.report.groups.map((g) => [g.key.id, g.totals.value.toString()]));
    // XP holds 60 ITSA4 (600) + all HGLG11 (1500) = 2100; Rico 40 ITSA4 = 400;
    // the CDB has no institution → Not classified = 1000.55.
    expect(byId.get(xp)).toBe('2100');
    expect(byId.get(rico)).toBe('400');
    expect(byId.get('__not_classified__')).toBe('1000.55');
  });

  it('AC-3 — wallet scope uses ALLOCATED quantities, not full positions', async () => {
    const retirementReport = unwrap(await query('asset', { kind: 'wallet', walletId: retirement }));
    const incomeReport = unwrap(await query('asset', { kind: 'wallet', walletId: income }));

    // 50 of 100 ITSA4 → 500, and 30 → 300. NOT 1000 in both, which is what a
    // report scoping by "which assets does this wallet touch" would show.
    expect(retirementReport.report.total.quantity.toString()).toBe('50');
    expect(retirementReport.report.total.value.toString()).toBe('500');
    expect(incomeReport.report.total.quantity.toString()).toBe('30');
    expect(incomeReport.report.total.value.toString()).toBe('300');

    // Neither wallet sees HGLG11 or the CDB — nothing was filed there.
    expect(retirementReport.report.groups).toHaveLength(1);
    expect(incomeReport.report.groups).toHaveLength(1);
  });

  it('wallet scope splits across institutions pro rata and still totals correctly', async () => {
    const result = unwrap(await query('institution', { kind: 'wallet', walletId: retirement }));
    const byId = new Map(result.report.groups.map((g) => [g.key.id, g.totals.quantity.toString()]));
    // Aposentadoria's 50 ITSA4 spread over XP (60%) and Rico (40%):
    //   XP   → 60 × 50/100 = 30
    //   Rico → 40 × 50/100 = 20
    expect(byId.get(xp)).toBe('30');
    expect(byId.get(rico)).toBe('20');
    expect(result.report.total.quantity.toString()).toBe('50');
  });

  it('AC-14 — an empty wallet renders the empty state, not a zero', async () => {
    const result = unwrap(await query('asset', { kind: 'wallet', walletId: emptyWallet }));
    expect(result.empty).toBe(true);
    expect(result.report.groups).toEqual([]);
  });

  it('BR-011-13 — the query reads the persisted snapshot series', async () => {
    const result = unwrap(await query('asset_class', { kind: 'portfolio' }));
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]!.date).toBe('2026-03-02');
    // The jsonb breakdown survives as exact decimal strings (AR-10).
    expect(result.snapshots[0]!.totalValue.toString()).toBe('3500.55');
    expect(result.snapshots[0]!.byAssetClass.get('cdb')!.toString()).toBe('1000.55');
    expect(result.snapshots[0]!.hasEstimates).toBe(true);
  });

  it('TS-12 — the holdings total equals the snapshot total for the same tenant', async () => {
    // The cross-report invariant: Composition's total and the Portfolio Value
    // endpoint must be the same number. The seeded snapshot was written to
    // agree with the seeded positions; a framework that summed differently
    // would put two figures for one portfolio on two screens.
    const result = unwrap(await query('asset', { kind: 'portfolio' }));
    expect(result.report.total.value.equals(result.snapshots[0]!.totalValue)).toBe(true);
  });

  it('AC-10 — a URL round trip reproduces period, scope and grouping', async () => {
    const state = {
      period: {
        kind: 'custom' as const,
        from: BusinessDate.of('2026-02-01'),
        to: BusinessDate.of('2026-06-30'),
      },
      scope: { kind: 'wallet' as const, walletId: income },
      grouping: 'institution' as Grouping,
    };
    const url = toQueryString(state, defaultGroupingFor(state.scope, undefined));
    const restored = fromSearchParams(new URLSearchParams(url.slice(1)), 'asset_class');
    expect(restored).toEqual(state);

    // ...and running the restored state produces the same figures.
    const result = unwrap(
      await withReportPort(userId, async (port) =>
        runReportQuery(
          port,
          {
            period: restored.period,
            scope: restored.scope,
            grouping: restored.grouping,
            today: TODAY,
          },
          null,
        ),
      ),
    );
    expect(result.range).toEqual({ from: '2026-02-01', to: '2026-06-30' });
    expect(result.scope.wallet?.name).toBe('Renda');
    expect(result.report.total.value.toString()).toBe('300');
  });

  it('AC-11 — CSV export preserves the grouping and neutralises injection', async () => {
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

    // A wallet named with a formula — user-supplied text reaching a spreadsheet.
    const hostile = WalletId.generate();
    await migratorPool.query(`INSERT INTO wallets (id, user_id, name) VALUES ($1, $2, $3)`, [
      hostile,
      userId,
      '=HYPERLINK("http://evil","click")',
    ]);
    await migratorPool.query(
      `INSERT INTO wallet_allocations (id, user_id, wallet_id, asset_id, quantity)
       VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
      [userId, hostile, hglg, '10'],
    );

    const { result, names } = await withReportPort(userId, async (port) => ({
      result: await runReportQuery(
        port,
        { period: { kind: 'ytd' }, scope: { kind: 'portfolio' }, grouping: 'wallet', today: TODAY },
        null,
      ),
      names: new Map((await port.listWallets()).map((w) => [w.walletId as string, w.name])),
    }));

    const csv = exportGroupedCsv(
      unwrap(result).report,
      labels,
      defaultGroupLabeller(labels, names),
    );

    expect(csv).toContain("'=HYPERLINK");
    expect(csv).not.toMatch(/(^|\r\n)=HYPERLINK/);
    // Grouping is preserved: the wallet names head their own rows.
    expect(csv).toContain('Aposentadoria,ITSA4');
    expect(csv).toContain('Não atribuído,');
    // The total row still reconciles to the scope total.
    expect(csv.split('\r\n').at(-1)).toContain(TOTAL);
  });

  it('refuses a scope naming a wallet this tenant does not have', async () => {
    const result = await query('asset', { kind: 'wallet', walletId: WalletId.generate() });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('REPORTING_WALLET_NOT_FOUND');
  });

  it('excludes positions closed to zero from every grouping', async () => {
    // A closed position is worth nothing and carries no price; keeping it
    // would put a zero row in every group.
    await migratorPool.query(
      `INSERT INTO positions (id, user_id, asset_id, institution_id, quantity, average_cost, total_cost, realized_gain)
       VALUES (gen_random_uuid(), $1, $2, $3, 0, 0, 0, 250)`,
      [userId, hglg, rico],
    );
    const result = unwrap(await query('asset', { kind: 'portfolio' }));
    expect(result.report.total.value.toString()).toBe(TOTAL);
    expect(result.report.groups).toHaveLength(3);
  });

  it('the holdings partition exactly — no slice counted twice or dropped', async () => {
    const result = unwrap(await query('wallet', { kind: 'portfolio' }));
    const holdings = result.report.groups.flatMap((group) => group.holdings);
    // ITSA4: 2 institutions × 3 wallet slices = 6; HGLG11: 1; CDB: 1.
    expect(holdings).toHaveLength(8);
    expect(totalsOf(holdings).value.toString()).toBe(TOTAL);
    expect(totalsOf(holdings).quantity.toString()).toBe(
      // 100 ITSA4 + 10 HGLG11 + 1 CDB
      Quantity.fromString('111').toString(),
    );
  });
});
