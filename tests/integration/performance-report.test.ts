import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { BusinessDate } from '@/core/shared/clock';
import { UserId, WalletId, type AssetId } from '@/core/shared/ids';
import { Money } from '@/core/shared/money';
import { DrizzleIndexSeriesRepository } from '@/adapters/db/index-series-repository';
import { EarningsTreatment, Rate } from '@/core/reporting/performance/ports';
import { runPerformanceReport, type PerformanceReport } from '@/core/reporting/performance/report';
import { DEFAULT_DIVERGENCE_POINTS } from '@/core/reporting/performance/xirr';
import type { Period, Scope } from '@/core/reporting/ports';
import { withReportPort } from '@/app/(app)/reports/data';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { seedAsset } from '../support/ledger-fixtures';
import { resetLedger, resetUsers, resetWallets } from '../support/reset';
import { seedUser } from '../support/users';

/**
 * SPEC-012 against **real Postgres** — the Performance Report end to end,
 * through the Drizzle adapters and `withTenant` (AR-11).
 *
 * What genuinely needs a database here rather than the fake port: the
 * `NUMERIC(20,8)` ⇄ `Decimal` round trip on the snapshot series (TESTING §1 —
 * where floating-point corruption would enter, and every figure this report
 * publishes is derived from those three columns), the RLS-scoped reads, and the
 * fact that `index_series` — a shared, RLS-exempt table (AR-15) — is readable
 * from inside a tenant transaction.
 *
 * **TS-03 / TS-33 / TS-34.** The suite shares one Postgres in CI, so this file
 * truncates everything it touches in **both** `beforeAll` and `afterAll`. The
 * `index_series` rows matter most: they are *global*, carry no `user_id`, and
 * are therefore invisible to `resetUsers`'s cascade — exactly the kind of row
 * TS-34 names as the one that leaks. A CDI point left behind here would change
 * the arithmetic of any later file that accumulates one.
 */
describe('SPEC-012 performance report (integration)', () => {
  let database: TestDatabase;
  let migratorPool: Pool;
  let indexSeries: DrizzleIndexSeriesRepository;
  let appPool: Pool;

  const userId = UserId.generate();
  const START = BusinessDate.of('2026-01-01');
  const END = BusinessDate.of('2027-01-01');

  let itsa: AssetId;
  let wallet: WalletId;

  /**
   * TS-34 — **`index_series` is the global table this file both writes and
   * reads, so it is emptied rather than filtered.**
   *
   * Deleting only this file's own rows was the first attempt and it failed
   * against a reused database, which is precisely the case TS-33 exists to
   * surface: `tests/integration/tesouro-bcb-sync.test.ts` truncates
   * `index_series` in its `beforeEach` and never in an `afterAll`, so it leaves
   * a CDI point behind. That point falls inside this report's period, compounds
   * into the benchmark line, and turned an exact 0,0005 into a figure that
   * looked plausible and was wrong — the whole failure mode this codebase is
   * built to avoid, arriving through a test fixture.
   *
   * Emptying the table in `beforeAll` protects this file from its predecessors
   * and emptying it in `afterAll` protects its successors from this one.
   */
  async function cleanUp(): Promise<void> {
    const pool = new Pool({ connectionString: database.migrationUrl, max: 1 });
    try {
      await pool.query('TRUNCATE index_series CASCADE');
    } finally {
      await pool.end();
    }
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

    migratorPool = new Pool({ connectionString: database.migrationUrl, max: 4 });
    appPool = new Pool({ connectionString: database.appUrl, max: 2 });
    indexSeries = new DrizzleIndexSeriesRepository(drizzle(appPool, { schema }));
  }, 180_000);

  afterAll(async () => {
    await migratorPool?.end();
    await appPool?.end();
    // TS-03: leave the shared database as this file found it.
    await cleanUp();
    await database.stop();
  });

  /**
   * The fixture, chosen so every figure is exact and hand-computable — the same
   * history the use-case test uses, so what this file adds is the storage round
   * trip rather than new arithmetic:
   *
   *   01/01/2026  value 100.000,55       contributions 100.000,55  proventos 0
   *   01/07/2026  value 110.000,605      contributions 100.000,55  proventos 0
   *   01/01/2027  value 108.900,59895    contributions 100.000,55  proventos 1.000
   *
   * Two decisions in those numbers:
   *
   *  - The trailing 0,55 is deliberate. It is not representable in binary
   *    floating point, so a `number` anywhere in the read path would surface as
   *    drift in the very first assertion.
   *  - The later values are exact multiples of it — 100.000,55 × 1,1 and then
   *    × 0,99 — so every daily return is a terminating decimal and the linked
   *    figure is an exact 0,089 rather than something only checkable to a
   *    tolerance. An awkward denominator proves the round trip; awkward
   *    *ratios* would only prove the tolerance was generous.
   */
  beforeEach(async () => {
    await resetWallets(database.migrationUrl);
    await migratorPool.query('TRUNCATE positions, daily_valuation_snapshots CASCADE');
    await migratorPool.query('TRUNCATE index_series CASCADE');

    wallet = WalletId.generate();
    await migratorPool.query(`INSERT INTO wallets (id, user_id, name) VALUES ($1, $2, $3)`, [
      wallet,
      userId,
      'Aposentadoria',
    ]);

    await migratorPool.query(
      `INSERT INTO positions (id, user_id, asset_id, institution_id, quantity, average_cost, total_cost, realized_gain)
       VALUES (gen_random_uuid(), $1, $2, NULL, 100, 100.0055, 10000.55, 0)`,
      [userId, itsa],
    );

    const rows: readonly [string, string, string, string][] = [
      ['2026-01-01', '100000.55', '100000.55', '0'],
      ['2026-07-01', '110000.605', '100000.55', '0'],
      ['2027-01-01', '108900.59895', '100000.55', '1000'],
    ];
    for (const [date, totalValue, netContributions, earnings] of rows) {
      await migratorPool.query(
        `INSERT INTO daily_valuation_snapshots (user_id, date, total_value, net_contributions, earnings_to_date, by_asset_class, has_estimates)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, false)`,
        [
          userId,
          date,
          totalValue,
          netContributions,
          earnings,
          JSON.stringify({ stock: totalValue }),
        ],
      );
    }

    // One published CDI day, so the accumulation is exact: 1,0005.
    await migratorPool.query(
      `INSERT INTO index_series (code, date, value, source)
       VALUES ('CDI', '2026-01-01', 0.05, 'spec-012-integration')
       ON CONFLICT (code, date) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source`,
    );
  });

  const PERIOD: Period = { kind: 'custom', from: START, to: END };

  async function run(options: {
    scope?: Scope;
    treatment?: EarningsTreatment;
    benchmarks?: readonly ('CDI' | 'IPCA' | 'IBOV')[];
  }): Promise<PerformanceReport> {
    // AR-11: the tenant-scoped reads all run inside one `withTenant`
    // transaction, so RLS has its context set exactly once for the whole report.
    const result = await withReportPort(userId, (port) =>
      runPerformanceReport(
        { port, indexSeries },
        {
          period: PERIOD,
          scope: options.scope ?? { kind: 'portfolio' },
          grouping: 'asset_class',
          today: END,
          treatment: options.treatment ?? EarningsTreatment.WITHOUT_EARNINGS,
          benchmarks: options.benchmarks ?? [],
          divergencePoints: DEFAULT_DIVERGENCE_POINTS,
          earliest: START,
        },
      ),
    );
    if (!result.ok) throw new Error(`expected a report, got ${result.error.code}`);
    return result.value;
  }

  function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
    if (!result.ok) throw new Error(`expected a value, got ${result.error.code}`);
    return result.value;
  }

  function errorCode(result: { ok: true } | { ok: false; error: { code: string } }): string {
    if (result.ok) throw new Error('expected an unavailable result');
    return result.error.code;
  }

  it('reads the snapshot series back as exact Decimal money, with no float drift', async () => {
    const report = await run({});
    expect(report.series!.points.map((point) => point.value.toString())).toEqual([
      '100000.55',
      '110000.605',
      '108900.59895',
    ]);
    // Contributions never changed after the opening balance, so every derived
    // flow is exactly zero — not 1e-11, which is what a float subtraction of
    // 100000.55 from itself would leave behind.
    expect(report.series!.flows.map((flow) => flow.amount.toString())).toEqual(['0', '0']);
  });

  /**
   * Hand-computed against the stored series, without earnings:
   *
   *   01/01 → 01/07  gain 110.000,605 − 100.000,55 = 10.000,055
   *                  r = 10.000,055 ÷ 100.000,55 = **0,10**
   *   01/07 → 01/01  gain 108.900,59895 − 110.000,605 = −1.100,00605
   *                  r = −1.100,00605 ÷ 110.000,605 = **−0,01**
   *   TWR = 1,10 × 0,99 − 1 = 1,089 − 1 = **0,089**
   *
   * and with no flows the factors telescope, so it is also
   * 108.900,59895 ÷ 100.000,55 − 1 = 1,089 − 1. XIRR sees exactly two flows a
   * year apart — the opening capital out, the closing value back — so it lands
   * on the same figure:
   *
   *   (1 + r)^1 = 108.900,59895 ÷ 100.000,55 = 1,089 → r = **0,089**
   */
  it('BR-012-01/03 — TWR and XIRR over the stored series', async () => {
    const report = await run({});
    const twr = unwrap(report.twr);
    const xirr = unwrap(report.xirr);

    expect(twr.returnRate.toString()).toBe('0.089');
    expect(xirr.rate.toString()).toBe('0.089');
    // No interim flow means the two measures have nothing to disagree about.
    expect(report.explainDivergence).toBe(false);
  });

  /**
   * BR-012-09 / AC-7 — both views over the same scope, and the gap between them
   * is exactly the proventos.
   *
   *   without gain = 108.900,59895 − 100.000,55 − 0     = **8.900,04895**
   *   with    gain = 108.900,59895 − 100.000,55 + 1.000 = **9.900,04895**
   */
  it('AC-7 — with-earnings exceeds without-earnings by exactly the proventos paid', async () => {
    const without = await run({ treatment: EarningsTreatment.WITHOUT_EARNINGS });
    const with_ = await run({ treatment: EarningsTreatment.WITH_EARNINGS });

    expect(without.series!.gain.toString()).toBe('8900.04895');
    expect(with_.series!.gain.toString()).toBe('9900.04895');
    expect(with_.series!.gain.minus(without.series!.gain).toString()).toBe('1000');
    expect(with_.series!.earningsInPeriod.toString()).toBe('1000');
    // AC-8: the dividend arrives as money out on pay date. A reinvestment
    // assumption would appear here as a positive flow — a buy that never
    // happened.
    expect(with_.series!.flows.some((flow) => flow.amount.isPositive())).toBe(false);
  });

  /**
   * BR-012-11 / AC-10 — "% do CDI" against a CDI accumulation read from the
   * shared `index_series` table.
   *
   *   one published day at 0,05 % → factor 1,0005 → CDI returned 0,0005
   *   0,089 ÷ 0,0005 × 100 = 178 × 100 = **17.800 % do CDI**
   *
   * (An extreme figure because the fixture publishes a single CDI day across a
   * whole year — but an exact one, which is what the assertion is for.)
   */
  it('AC-10 — accumulates CDI from index_series inside the tenant transaction', async () => {
    const report = await run({ benchmarks: ['CDI'] });

    const line = unwrap(report.benchmarks[0]!.line);
    expect(line.returnRate.toString()).toBe('0.0005');
    expect(unwrap(report.percentOfCdi).toString()).toBe('17800');
  });

  /**
   * AC-11 — the shadow portfolio replays the user's own flows. This history has
   * none after the opening balance, so it is the opening *patrimônio* growing
   * at CDI alone:
   *
   *   100.000,55 × 1,0005 = **100.050,55027500** (to the eight places the money
   *   type carries: 100.000,55 × 0,0005 = 50,000275)
   */
  it('AC-11 — the shadow portfolio grows the opening value at the benchmark rate', async () => {
    const report = await run({ benchmarks: ['CDI'] });
    expect(report.benchmarks[0]?.shadow?.finalValue.toString()).toBe('100050.550275');
  });

  /**
   * BR-012-16 / AC-13 — the contributions reconcile to the scope total.
   *
   * Note what the figure currently *is*: the position adapter values a holding
   * at its cost basis until SPEC-009's valued read model is exposed for an
   * arbitrary as-of date (a deviation already documented in
   * `src/app/(app)/reports/data.ts`), so value and cost are the same number and
   * the decomposition's return is zero. The **invariant** is what this asserts,
   * and it holds whatever the valuation says.
   */
  it('AC-13 — group contributions sum exactly to the scope total return', async () => {
    const report = await run({});
    const contribution = unwrap(report.contribution);

    expect(contribution.totalBase.toString()).toBe('10000.55');
    const summed = contribution.groups.reduce(
      (acc: Rate, group) => acc.plus(group.contribution),
      Rate.zero(),
    );
    expect(summed.equals(contribution.totalReturn)).toBe(true);
    expect(contribution.groups.map((group) => group.key.id)).toEqual(['stock']);
  });

  /**
   * AC-16 — wallet scope. `daily_valuation_snapshots` is persisted at portfolio
   * grain, so there is no per-wallet series to link and the time-weighted
   * measures report unavailable rather than borrowing the portfolio's.
   */
  it('AC-16 — wallet scope reports the series-backed measures as unavailable', async () => {
    const report = await run({ scope: { kind: 'wallet', walletId: wallet } });

    expect(errorCode(report.twr)).toBe('PERFORMANCE_SCOPE_SERIES_UNAVAILABLE');
    expect(errorCode(report.xirr)).toBe('PERFORMANCE_SCOPE_SERIES_UNAVAILABLE');
    // Nothing is allocated to this wallet, so the scope is empty — the empty
    // state, not a zero return.
    expect(report.empty).toBe(true);
  });

  it('refuses a scope naming a wallet this tenant does not have', async () => {
    const result = await withReportPort(userId, (port) =>
      runPerformanceReport(
        { port, indexSeries },
        {
          period: PERIOD,
          scope: { kind: 'wallet', walletId: WalletId.generate() },
          grouping: 'asset_class',
          today: END,
          treatment: EarningsTreatment.WITHOUT_EARNINGS,
          benchmarks: [],
          divergencePoints: DEFAULT_DIVERGENCE_POINTS,
          earliest: START,
        },
      ),
    );
    expect(errorCode(result)).toBe('REPORTING_WALLET_NOT_FOUND');
  });

  /**
   * BR-012-18 / AC-15 — a period with no snapshots at all renders the empty
   * state rather than a zero or an infinite return.
   */
  it('AC-15 — a period before the tenant has any history is an empty state', async () => {
    const result = await withReportPort(userId, (port) =>
      runPerformanceReport(
        { port, indexSeries },
        {
          period: {
            kind: 'custom',
            from: BusinessDate.of('2020-01-01'),
            to: BusinessDate.of('2020-12-31'),
          },
          scope: { kind: 'portfolio' },
          grouping: 'asset_class',
          today: END,
          treatment: EarningsTreatment.WITHOUT_EARNINGS,
          benchmarks: ['CDI'],
          divergencePoints: DEFAULT_DIVERGENCE_POINTS,
          earliest: START,
        },
      ),
    );
    if (!result.ok) throw new Error('expected a report, not a failure');

    expect(errorCode(result.value.twr)).toBe('PERFORMANCE_NO_SERIES');
    expect(errorCode(result.value.xirr)).toBe('PERFORMANCE_XIRR_INSUFFICIENT_FLOWS');
    // The CDI series does not reach back that far either, and says so rather
    // than drawing a flat line.
    expect(errorCode(result.value.benchmarks[0]!.line)).toBe('PERFORMANCE_BENCHMARK_SERIES_EMPTY');
  });

  /**
   * TS-12 — the cross-report invariant. The series the Performance Report links
   * and the figure the Portfolio Value endpoint publishes are the same stored
   * number, not two derivations of it.
   */
  it('TS-12 — the report’s closing value is the stored snapshot total', async () => {
    const report = await run({});
    const { rows } = await migratorPool.query<{ total_value: string }>(
      `SELECT total_value FROM daily_valuation_snapshots WHERE user_id = $1 AND date = $2`,
      [userId, END],
    );
    const stored = Money.fromString(rows[0]!.total_value);
    const closing = report.series!.points[report.series!.points.length - 1]!.value;
    expect(closing.equals(stored)).toBe(true);
    expect(report.range).toEqual({ from: START, to: END });
    expect(report.scope.wallet).toBeNull();
    // ...and the mid-period snapshot is in the series it linked, rather than
    // the report having quietly reduced a three-point history to its endpoints.
    expect(report.series!.points.map((point) => point.date)).toEqual([
      '2026-01-01',
      '2026-07-01',
      '2027-01-01',
    ]);
  });
});
