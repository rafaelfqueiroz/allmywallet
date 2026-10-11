import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BusinessDate, FakeClock } from '@/core/shared/clock';
import { UserId, WalletId, type AssetId, type InstitutionId } from '@/core/shared/ids';
import { Money, sumMoney } from '@/core/shared/money';
import { runReportQuery } from '@/core/reporting/base-query';
import type { Scope } from '@/core/reporting/ports';
import { buildPortfolioValueReport } from '@/core/reporting/portfolio-value/report';
import { withReportPort } from '@/app/(app)/reports/data';
import { loadCurrentComposition } from '@/app/(app)/portfolio/data';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { seedAsset, seedInstitution } from '../support/ledger-fixtures';
import { resetLedger, resetUsers, resetWallets } from '../support/reset';
import { seedUser } from '../support/users';

/**
 * SPEC-022 #208 — Portfólio reads current state with no period, and SPEC-015
 * BR-015-10 still holds: **the Composição total equals the Evolução
 * patrimonial endpoint for the same scope and date** (SPEC-013 BR-013-12).
 *
 * Moving Composição out of Relatórios replaced its period with the single day
 * today (`loadCurrentComposition`). This holds that change to the rule: the
 * figure is compared against the Evolução report built through its own path
 * (`runReportQuery` + `buildPortfolioValueReport`, as `loadPatrimonio` does)
 * over a year-to-date period ending the same day — not against a hardcoded
 * number, because equality is the property. Hand-computed anyway, so the
 * fixture is not self-referential (TS-04):
 *
 *   PETR4 100 × R$ 38,42 = R$ 3.842,00, all of it in the wallet
 *   VALE3  50 × R$ 61,10 = R$ 3.055,00, unassigned
 *                 portfolio R$ 6.897,00
 *
 * **The clock is pinned** (AR-03), and so is every global row this file
 * seeds: `assets`, `price_quotes` and `latest_quotes` are non-tenant, and the
 * CI database is shared across files (TS-03/TS-34), so they are truncated in
 * both `beforeAll` and `afterAll`.
 */
describe('#208 — Portfólio current state (integration)', () => {
  let database: TestDatabase;
  let migratorPool: Pool;

  const userId = UserId.generate();
  const walletId = WalletId.generate();
  const TODAY = BusinessDate.of('2026-03-20');
  // 12:00Z is 09:00 in São Paulo — the same calendar day either way.
  const clock = new FakeClock('2026-03-20T12:00:00Z');

  let petr: AssetId;
  let vale: AssetId;
  let xp: InstitutionId;

  async function cleanUp(): Promise<void> {
    await resetWallets(database.migrationUrl);
    await resetLedger(database.migrationUrl);
    await resetUsers(database.migrationUrl);
    const pool = new Pool({ connectionString: database.migrationUrl, max: 1 });
    try {
      await pool.query(
        'TRUNCATE index_series, price_quotes, latest_quotes, daily_valuation_snapshots, fixed_income_contracts, assets RESTART IDENTITY CASCADE',
      );
    } finally {
      await pool.end();
    }
  }

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.migrationUrl);
    await cleanUp();
    await seedUser(database.migrationUrl, userId);

    petr = (await seedAsset(database.migrationUrl, 'PETR4', 'Petrobras PN')).id;
    vale = (await seedAsset(database.migrationUrl, 'VALE3', 'Vale ON')).id;
    xp = await seedInstitution(database.migrationUrl, 'XP Investimentos');

    migratorPool = new Pool({ connectionString: database.migrationUrl, max: 4 });
  }, 180_000);

  afterAll(async () => {
    await migratorPool?.end();
    await cleanUp();
    await database.stop();
  });

  beforeEach(async () => {
    await migratorPool.query(
      'TRUNCATE positions, price_quotes, latest_quotes, wallet_allocation_events, ' +
        'wallet_allocations, wallet_asset_rules, wallets, daily_valuation_snapshots CASCADE',
    );

    for (const [assetId, quantity, averageCost, close] of [
      [petr, '100', '32.15', '38.42'],
      [vale, '50', '60', '61.10'],
    ] as const) {
      await migratorPool.query(
        `INSERT INTO positions (id, user_id, asset_id, institution_id, quantity, average_cost, total_cost, realized_gain)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $4::numeric * $5::numeric, 0)`,
        [userId, assetId, xp, quantity, averageCost],
      );
      await migratorPool.query(
        `INSERT INTO price_quotes (asset_id, date, close, source) VALUES ($1, $2, $3, 'test')`,
        [assetId, TODAY, close],
      );
    }

    await migratorPool.query(
      `INSERT INTO wallets (id, user_id, name) VALUES ($1, $2, 'Longo prazo')`,
      [walletId, userId],
    );
    await migratorPool.query(
      `INSERT INTO wallet_allocations (id, user_id, wallet_id, asset_id, quantity)
       VALUES (gen_random_uuid(), $1, $2, $3, 100)`,
      [userId, walletId, petr],
    );
  });

  /** Evolução patrimonial's endpoint, built through its own path. */
  async function evolucaoEndpoint(scope: Scope) {
    return withReportPort(userId, async (port) => {
      const query = await runReportQuery(
        port,
        { period: { kind: 'ytd' }, scope, grouping: 'asset_class', today: TODAY },
        await port.earliestSnapshotDate(),
      );
      if (!query.ok) throw new Error(query.error.code);
      return buildPortfolioValueReport({
        query: query.value,
        opening: await port.findSnapshotBefore(query.value.range.from),
        grouping: 'asset_class',
        today: TODAY,
        lastImportAt: await port.lastImportAt(),
      }).headline.currentValue;
    });
  }

  for (const [label, scope, expected] of [
    ['the whole portfolio', { kind: 'portfolio' }, '6897.00'],
    ['one wallet', { kind: 'wallet', walletId }, '3842.00'],
  ] as const) {
    it(`BR-015-10: the Composição total equals the Evolução endpoint — ${label}`, async () => {
      const current = await loadCurrentComposition(
        userId,
        { scope: scope as Scope, grouping: 'asset_class' },
        clock,
      );
      expect(current.report).not.toBeNull();
      const total = current.report?.total.value;

      expect(total?.toDecimal().toFixed(2)).toBe(expected);
      expect(total?.toDecimal().toFixed(8)).toBe(
        (await evolucaoEndpoint(scope as Scope)).toDecimal().toFixed(8),
      );
      // BR-015-10's other half: the shares sum to exactly 100 %, by construction.
      const shares = (current.report?.breakdown ?? []).map((slice) => slice.share ?? Money.zero());
      expect(sumMoney(shares).toString()).toBe('1');
    });
  }

  /**
   * The grouping re-partitions the same figures (BR-011-08): Carteiras'
   * comparison (by wallet) and Patrimônio (by class) total the same portfolio,
   * and the wallet plus Não atribuído are exactly that total.
   */
  it('the wallet comparison and Não atribuído add up to the portfolio', async () => {
    const byWallet = await loadCurrentComposition(
      userId,
      { scope: { kind: 'portfolio' }, grouping: 'wallet' },
      clock,
    );
    const values = byWallet.report?.breakdown.map((slice) =>
      slice.totals.value.toDecimal().toFixed(2),
    );
    expect(values).toEqual(['3842.00', '3055.00']);
    expect(byWallet.report?.total.value.toDecimal().toFixed(2)).toBe('6897.00');
  });

  it('runs over the single day today, valued at today', async () => {
    const current = await loadCurrentComposition(
      userId,
      { scope: { kind: 'portfolio' }, grouping: 'asset_class' },
      clock,
    );
    expect(current.query.ok && current.query.value.range).toEqual({ from: TODAY, to: TODAY });
    expect(current.report?.quotes.valuationAsOf).toBe(TODAY);
  });
});
