import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BusinessDate, FakeClock } from '@/core/shared/clock';
import { UserId, WalletId, type AssetId, type InstitutionId } from '@/core/shared/ids';
import { loadDashboard } from '@/app/(app)/dashboard/data';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { seedAsset, seedInstitution } from '../support/ledger-fixtures';
import { resetLedger, resetUsers, resetWallets } from '../support/reset';
import { seedUser } from '../support/users';

/**
 * TS-14/TS-15 — tenant isolation **at the dashboard surface**, which is the
 * densest aggregate this product renders: one number summarising somebody's
 * entire *patrimônio*, plus a verdict about whether it agrees with B3 and a
 * list of what they still have to do.
 *
 * SPEC-003 DL-003-03 is explicit that leaks happen in aggregates rather than in
 * visible stranger rows. A missing tenant predicate here does not show B's
 * name on A's screen; it shows A a **total that is too large**, a discrepancy
 * count for an import A never ran, and an allocation queue naming an asset A
 * does not hold — all of which look like a working dashboard.
 *
 * So this asserts more than "B's rows are absent": it asserts A's figures are
 * *exactly* A's, across all four elements of the read model.
 *
 * The dashboard adds one genuinely new read path over SPEC-011's
 * (`tests/isolation/reporting.test.ts`): `countNeedsAttentionByBatch`, a
 * **join** across `import_rows` and `import_batches`. A join is where a tenant
 * predicate is easiest to lose, because RLS on one side reads as covering both.
 */
describe('#98 — dashboard surface tenant isolation', () => {
  let database: TestDatabase;
  let migratorPool: Pool;

  const userA = UserId.generate();
  const userB = UserId.generate();
  const clock = new FakeClock('2026-05-05T12:00:00Z');
  const TODAY = BusinessDate.of('2026-05-05');

  let petr: AssetId;
  let vale: AssetId;
  let xp: InstitutionId;
  const walletB = WalletId.generate();

  /** A's only batch: a Movimentação commit with nothing outstanding in it. */
  const BATCH_A = '01920000-0000-7000-8000-0000000009a1';
  /** B's Posição commit, carrying nine discrepancies. */
  const BATCH_B_POSICAO = '01920000-0000-7000-8000-0000000009b1';
  /** B's Movimentação commit, carrying seven unclassified rows. */
  const BATCH_B_MOVIMENTACAO = '01920000-0000-7000-8000-0000000009b2';

  async function cleanUp(): Promise<void> {
    await resetWallets(database.migrationUrl);
    await resetLedger(database.migrationUrl);
    await resetUsers(database.migrationUrl);
    const pool = new Pool({ connectionString: database.migrationUrl, max: 1 });
    try {
      await pool.query(
        'TRUNCATE price_quotes, latest_quotes, daily_valuation_snapshots, assets RESTART IDENTITY CASCADE',
      );
    } finally {
      await pool.end();
    }
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
    xp = await seedInstitution(database.migrationUrl, 'XP Investimentos');

    migratorPool = new Pool({ connectionString: database.migrationUrl, max: 4 });

    /*
     * A holds 10 PETR4 at R$ 10,00 — R$ 100,00.
     * B holds 50 VALE3 at R$ 19.999,98 — R$ 999.999,00, a figure large enough
     * that any leak changes A's total unmistakably rather than plausibly.
     */
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

    // B allocates everything, so B contributes no pending item of its own —
    // anything in A's queue naming VALE3 could only have leaked.
    await migratorPool.query(`INSERT INTO wallets (id, user_id, name) VALUES ($1, $2, $3)`, [
      walletB,
      userB,
      'Carteira B',
    ]);
    await migratorPool.query(
      `INSERT INTO wallet_allocations (id, user_id, wallet_id, asset_id, quantity)
       VALUES (gen_random_uuid(), $1, $2, $3, '50')`,
      [userB, walletB, vale],
    );

    /*
     * A has never reconciled. B has, and found nine discrepancies — so a leak
     * shows as A's dashboard claiming a reconciliation A never ran, which is
     * the worst of the failures here: it is an assurance about someone else's
     * data presented as an assurance about yours.
     */
    await migratorPool.query(
      `INSERT INTO import_batches (id, user_id, source, status, uploaded_at, committed_at, reconciliation)
       VALUES ($1, $2, 'b3_posicao', 'committed', now(), '2026-05-01T14:00:00Z', $3::jsonb)`,
      [
        BATCH_B_POSICAO,
        userB,
        JSON.stringify({
          asOf: '2026-05-01',
          status: 'discrepancies_found',
          discrepancies: Array.from({ length: 9 }, () => ({
            assetId: vale,
            assetCode: 'VALE3',
            institutionId: null,
            computedQuantity: '50',
            b3Quantity: '60',
            difference: '10',
            cause: 'missing_history_before_import_range',
            resolved: false,
          })),
        }),
      ],
    );

    // A Movimentação batch for each, with unclassified rows only on B's — the
    // join in `countNeedsAttentionByBatch` is what this is aimed at.
    for (const [batchId, userId, assetId, rows, committedAt] of [
      [BATCH_A, userA, petr, 0, '2026-05-02T14:00:00Z'],
      // Committed two days *after* A's, so a leaked `lastImportAt` reports a
      // date A could not have produced rather than one that happens to match.
      [BATCH_B_MOVIMENTACAO, userB, vale, 7, '2026-05-04T14:00:00Z'],
    ] as const) {
      await migratorPool.query(
        `INSERT INTO import_batches (id, user_id, source, status, uploaded_at, committed_at)
         VALUES ($1, $2, 'b3_movimentacao', 'committed', now(), $3)`,
        [batchId, userId, committedAt],
      );
      for (let i = 0; i < rows; i += 1) {
        await migratorPool.query(
          `INSERT INTO import_rows (id, user_id, batch_id, raw_payload, parsed_payload, classification, asset_id)
           VALUES (gen_random_uuid(), $1, $2, '{}'::jsonb, $3::jsonb, 'unclassified', $4)`,
          [
            userId,
            batchId,
            JSON.stringify({
              kind: 'transaction',
              b3Type: 'Desconhecido',
              direction: null,
              assetCode: 'VALE3',
              assetName: 'Vale ON',
              assetClass: 'stock',
              institutionName: null,
              tradeDate: '2026-05-01',
              quantity: '1',
              unitPrice: '1',
              fees: '0',
              ratio: null,
            }),
            assetId,
          ],
        );
      }
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
    // TS-03: leave the shared database as this file found it.
    await cleanUp();
    await database.stop();
  });

  it("A's patrimônio is exactly A's", async () => {
    const { summary } = await loadDashboard(userA, clock);

    // A leak would read 1000099, not as a visible stranger's row.
    expect(summary.portfolio).toMatchObject({ kind: 'valued' });
    if (summary.portfolio.kind !== 'valued') throw new Error('unreachable');
    expect(summary.portfolio.value.toString()).toBe('100');
    expect(summary.freshness.valuationAsOf).toBe(TODAY);
  });

  it("B's patrimônio is exactly B's", async () => {
    const { summary } = await loadDashboard(userB, clock);

    expect(summary.portfolio).toMatchObject({ kind: 'valued' });
    if (summary.portfolio.kind !== 'valued') throw new Error('unreachable');
    expect(summary.portfolio.value.toString()).toBe('999999');
  });

  it("A's reconciliation status never reports B's import", async () => {
    const { summary } = await loadDashboard(userA, clock);

    // The dangerous leak is not "discrepancies found" — it is any assurance at
    // all about a comparison this tenant never ran.
    expect(summary.reconciliation).toEqual({
      state: 'never_reconciled',
      asOf: null,
      unresolvedCount: 0,
      resolvedCount: 0,
      batchId: null,
    });
  });

  it("A's needs-attention queue holds only A's own work", async () => {
    const { summary } = await loadDashboard(userA, clock);

    // A's own pending allocation: 10 PETR4 with no wallet.
    expect(summary.attention).toEqual([
      expect.objectContaining({ kind: 'pending_allocation', assetCode: 'PETR4' }),
    ]);
    // Not one of B's seven unclassified rows crossed the join.
    expect(summary.attention.some((item) => item.kind === 'import_rows')).toBe(false);
    expect(JSON.stringify(summary.attention)).not.toContain('VALE3');
    expect(JSON.stringify(summary.attention)).not.toContain(BATCH_B_MOVIMENTACAO);
  });

  it("B's unclassified rows are counted for B, so the absence above is isolation", async () => {
    // Without this the previous assertion would also pass against a query that
    // counts nothing for anyone — the failure mode a negative-only test cannot
    // tell apart from working isolation.
    const { summary } = await loadDashboard(userB, clock);

    expect(summary.attention).toEqual([
      { kind: 'import_rows', batchId: BATCH_B_MOVIMENTACAO, count: 7 },
    ]);
  });

  it("A's last-import date is A's own, not the newest in the table", async () => {
    const { summary } = await loadDashboard(userA, clock);

    // B committed on 2026-05-04; a leak would report that date for A.
    expect(summary.freshness.lastImportAt).toBe('2026-05-02');
  });
});
