import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BusinessDate, FakeClock } from '@/core/shared/clock';
import { ImportBatchId, UserId, type AssetId } from '@/core/shared/ids';
import { isOk } from '@/core/shared/result';
import { DrizzleFixedIncomeContractRepository } from '@/adapters/db/fixed-income-contract-repository';
import { db } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { loadDashboard } from '@/app/(app)/dashboard/data';
import {
  dismissOnboardingFor,
  loadOnboardingStatus,
  reopenOnboardingFor,
} from '@/app/(app)/onboarding/data';
import { supplyContractTermsFor } from '@/app/(app)/fixed-income/data';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { seedAsset } from '../support/ledger-fixtures';
import { resetLedger, resetUsers, resetWallets } from '../support/reset';
import { seedUser } from '../support/users';

/**
 * SPEC-020 — onboarding status, dismissal and the fixed-income gate, against
 * real Postgres.
 *
 * TS-03/TS-34: the CI database is shared across suite files, so `assets` and
 * `daily_valuation_snapshots` (a non-ledger, non-wallet table `resetLedger`/
 * `resetWallets` do not cover) are truncated explicitly in `beforeEach`.
 */
describe('SPEC-020 — onboarding status and gates (integration)', () => {
  let database: TestDatabase;
  let migratorPool: Pool;

  const userId = UserId.generate();
  const clock = new FakeClock('2026-03-20T12:00:00Z');

  let petr: AssetId;
  let cdb: AssetId;

  async function cleanUp(): Promise<void> {
    await resetWallets(database.migrationUrl);
    await resetLedger(database.migrationUrl);
    await resetUsers(database.migrationUrl);
    const pool = new Pool({ connectionString: database.migrationUrl, max: 1 });
    try {
      await pool.query(
        'TRUNCATE daily_valuation_snapshots, fixed_income_contracts, assets RESTART IDENTITY CASCADE',
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
    cdb = (await seedAsset(database.migrationUrl, 'CDB-BANCO-X', 'CDB 110% CDI', 'cdb')).id;

    migratorPool = new Pool({ connectionString: database.migrationUrl, max: 4 });
  }, 180_000);

  afterAll(async () => {
    await migratorPool?.end();
    await cleanUp();
    await database.stop();
  });

  beforeEach(async () => {
    await migratorPool.query(
      'TRUNCATE positions, transactions, import_batches, fixed_income_contracts, ' +
        'daily_valuation_snapshots, wallets CASCADE',
    );
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function seedBatch(input: {
    id: string;
    status?: string;
    committedAt?: string | null;
  }): Promise<void> {
    const committedAt =
      input.committedAt === undefined
        ? (input.status ?? 'committed') === 'committed'
          ? '2026-03-18T14:00:00Z'
          : null
        : input.committedAt;
    await migratorPool.query(
      `INSERT INTO import_batches (id, user_id, source, status, uploaded_at, committed_at)
       VALUES ($1, $2, 'b3_negociacao', $3, now(), $4)`,
      [input.id, userId, input.status ?? 'committed', committedAt],
    );
  }

  async function seedTransaction(input: {
    id: string;
    assetId: AssetId;
    naturalKey: string;
    status?: string;
    batchId?: string | null;
  }): Promise<void> {
    await migratorPool.query(
      `INSERT INTO transactions
         (id, user_id, asset_id, type, status, trade_date, quantity, unit_price, fees, total_value,
          natural_key, occurrence, import_batch_id)
       VALUES ($1, $2, $3, 'buy', $4, '2026-03-10', '10', '1', '0', '10', $5, 1, $6)`,
      [
        input.id,
        userId,
        input.assetId,
        input.status ?? 'active',
        input.naturalKey,
        input.batchId ?? null,
      ],
    );
  }

  async function seedPosition(
    assetId: AssetId,
    quantity: string,
    averageCost: string,
    totalCost: string,
  ): Promise<void> {
    await migratorPool.query(
      `INSERT INTO positions (id, user_id, asset_id, institution_id, quantity, average_cost, total_cost, realized_gain)
       VALUES (gen_random_uuid(), $1, $2, NULL, $3, $4, $5, 0)`,
      [userId, assetId, quantity, averageCost, totalCost],
    );
  }

  async function seedSnapshot(date: string): Promise<void> {
    await migratorPool.query(
      `INSERT INTO daily_valuation_snapshots
         (user_id, date, total_value, net_contributions, earnings_to_date, by_asset_class, has_estimates)
       VALUES ($1, $2, '100', '100', '0', '{}'::jsonb, false)`,
      [userId, date],
    );
  }

  async function seedContract(
    assetId: AssetId,
    opts: {
      indexer?: string | null;
      rate?: string | null;
      issueDate?: string;
    } = {},
  ): Promise<void> {
    await migratorPool.query(
      `INSERT INTO fixed_income_contracts (id, user_id, asset_id, indexer, rate, issue_date, principal)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, '10000')`,
      [userId, assetId, opts.indexer ?? null, opts.rate ?? null, opts.issueDate ?? '2026-01-10'],
    );
  }

  const load = () => loadOnboardingStatus(userId);
  const dashboard = () => loadDashboard(userId, clock);

  // -------------------------------------------------------------------------
  // Status derivation (BR-020-03/06/07/08)
  // -------------------------------------------------------------------------

  describe('status derivation', () => {
    it('guides a brand new user, incomplete, stage upload', async () => {
      const status = await load();

      expect(status.shouldGuide).toBe(true);
      expect(status.complete).toBe(false);
      expect(status.stage).toBe('upload');
      expect(status.stagedBatchId).toBeNull();
    });

    it('stays incomplete through pending then previewed staging (BR-020-04)', async () => {
      const BATCH = '01920000-0000-7000-8000-0000000000a1';
      await seedBatch({ id: BATCH, status: 'pending', committedAt: null });

      const pending = await load();
      expect(pending.complete).toBe(false);
      expect(pending.stage).toBe('processing');
      expect(pending.stagedBatchId).toBe(BATCH);

      await migratorPool.query(`UPDATE import_batches SET status = 'previewed' WHERE id = $1`, [
        BATCH,
      ]);

      const previewed = await load();
      expect(previewed.complete).toBe(false);
      expect(previewed.stage).toBe('review');
      expect(previewed.stagedBatchId).toBe(BATCH);
    });

    it('is complete once a batch is committed (BR-020-03)', async () => {
      await seedBatch({ id: '01920000-0000-7000-8000-0000000000a2', status: 'committed' });

      const status = await load();

      expect(status.complete).toBe(true);
      expect(status.stage).toBe('done');
      expect(status.shouldGuide).toBe(false);
    });

    /**
     * BR-020-08 — "deleting the only import makes onboarding incomplete
     * again, and the dashboard returns to its empty state." There is no
     * in-product "delete import" feature (SPEC-005 defines none), so this
     * simulates it the only way it can happen today: removing the batch, the
     * transaction it produced, and the derived position/snapshot rows at the
     * database level — exactly what a real deletion feature would need to
     * clean up.
     */
    it('reverts to incomplete, and the dashboard to its onboarding empty state, once the only import is deleted', async () => {
      const BATCH = '01920000-0000-7000-8000-0000000000a3';
      await seedBatch({ id: BATCH, status: 'committed' });
      await seedTransaction({
        id: '01920000-0000-7000-8000-0000000000b1',
        assetId: petr,
        naturalKey: 'onb-delete-1',
        batchId: BATCH,
      });
      await seedPosition(petr, '10', '10', '100');
      await seedSnapshot('2026-03-18');

      const before = await load();
      expect(before.complete).toBe(true);
      const beforeDashboard = await dashboard();
      expect(beforeDashboard.summary.portfolio.kind).not.toBe('onboarding');

      await migratorPool.query('DELETE FROM daily_valuation_snapshots WHERE user_id = $1', [
        userId,
      ]);
      await migratorPool.query('DELETE FROM positions WHERE user_id = $1', [userId]);
      await migratorPool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
      await migratorPool.query('DELETE FROM import_batches WHERE user_id = $1', [userId]);

      const after = await load();
      expect(after.complete).toBe(false);
      expect(after.shouldGuide).toBe(true);

      const afterDashboard = await dashboard();
      expect(afterDashboard.summary.portfolio).toEqual({ kind: 'onboarding' });
    });
  });

  // -------------------------------------------------------------------------
  // Dismissal (BR-020-09/11/12/13)
  // -------------------------------------------------------------------------

  describe('dismissal', () => {
    it('persists across two independent loads and a fresh session', async () => {
      await dismissOnboardingFor(userId);

      const first = await loadOnboardingStatus(userId);
      // A second, entirely independent call — a new "session" in the sense
      // that nothing is carried between the two beyond the database row.
      const second = await loadOnboardingStatus(userId);

      expect(first.dismissed).toBe(true);
      expect(second.dismissed).toBe(true);
    });

    it('never marks a step complete (BR-020-12)', async () => {
      await dismissOnboardingFor(userId);

      const status = await load();

      expect(status.dismissed).toBe(true);
      expect(status.complete).toBe(false);
      expect(status.steps.import).toBe(false);
    });

    /** BR-020-14 — dismissing guidance is not the same as declining the product. */
    it('a dismissed guide with no import still shows the dashboard empty state', async () => {
      await dismissOnboardingFor(userId);

      const status = await load();
      expect(status.complete).toBe(false);
      expect(status.shouldGuide).toBe(false);

      const result = await dashboard();
      expect(result.summary.portfolio).toEqual({ kind: 'onboarding' });
    });

    it('reopening clears the dismissal (BR-020-13)', async () => {
      await dismissOnboardingFor(userId);
      expect((await load()).dismissed).toBe(true);

      await reopenOnboardingFor(userId);

      expect((await load()).dismissed).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Gates never block completion (BR-020-17)
  // -------------------------------------------------------------------------

  describe('gates do not block completion', () => {
    it('is complete with a held rate-missing contract and an unclassified transaction', async () => {
      const BATCH = '01920000-0000-7000-8000-0000000000a4';
      await seedBatch({ id: BATCH, status: 'committed' });
      await seedTransaction({
        id: '01920000-0000-7000-8000-0000000000b2',
        assetId: petr,
        naturalKey: 'onb-unclassified-1',
        status: 'unclassified',
        batchId: BATCH,
      });
      await seedPosition(cdb, '1', '10000', '10000');
      await seedContract(cdb, { indexer: null, rate: null });

      const status = await load();

      expect(status.complete).toBe(true);
      expect(status.steps.fixedIncomeRates).toBe(false);
      expect(status.steps.classification).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // The fixed-income gate (BR-020-19)
  // -------------------------------------------------------------------------

  describe('the fixed-income gate', () => {
    it('appears in loadDashboard attention, and clears once supplied', async () => {
      await seedPosition(cdb, '1', '10000', '10000');
      await seedContract(cdb, { indexer: null, rate: null, issueDate: '2026-01-10' });

      const before = await dashboard();
      expect(before.summary.attention).toContainEqual(
        expect.objectContaining({ kind: 'fixed_income_rate', assetId: cdb }),
      );

      const result = await supplyContractTermsFor(userId, {
        assetId: cdb,
        indexer: 'cdi_percent',
        ratePercent: '110',
      });
      expect(isOk(result)).toBe(true);

      const after = await dashboard();
      expect(after.summary.attention.some((item) => item.kind === 'fixed_income_rate')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // upsertByAsset preserves a user-supplied rate (BR-020-19)
  // -------------------------------------------------------------------------

  describe('a later import cannot erase a user-supplied rate', () => {
    it('upsertByAsset with a null rate keeps the previously supplied one', async () => {
      const BATCH = '01920000-0000-7000-8000-0000000000c1';
      await seedBatch({ id: BATCH, status: 'committed' });
      await seedContract(cdb, { indexer: null, rate: null, issueDate: '2026-01-10' });

      const supplied = await supplyContractTermsFor(userId, {
        assetId: cdb,
        indexer: 'cdi_percent',
        ratePercent: '110',
      });
      expect(isOk(supplied)).toBe(true);

      // Simulates a later Posição re-import whose extract could not read the
      // rate this time — `upsertByAsset` is the writer that path uses.
      await withTenant(
        userId,
        async (tx) => {
          const repo = new DrizzleFixedIncomeContractRepository(tx, userId);
          await repo.upsertByAsset({
            assetId: cdb,
            indexer: null,
            ratePercent: null,
            issueDate: BusinessDate.of('2026-01-10'),
            maturityDate: null,
            principal: null,
            source: ImportBatchId.of(BATCH),
          });
        },
        db,
      );

      const { rows } = await migratorPool.query<{ indexer: string; rate: string }>(
        'SELECT indexer, rate FROM fixed_income_contracts WHERE user_id = $1 AND asset_id = $2',
        [userId, cdb],
      );
      expect(rows[0]?.indexer).toBe('cdi_percent');
      expect(Number(rows[0]?.rate)).toBe(110);
    });

    it('a re-import with only one of indexer or rate readable keeps the supplied pair intact', async () => {
      const BATCH = '01920000-0000-7000-8000-0000000000c2';
      await seedBatch({ id: BATCH, status: 'committed' });
      await seedContract(cdb, { indexer: null, rate: null, issueDate: '2026-01-10' });

      const supplied = await supplyContractTermsFor(userId, {
        assetId: cdb,
        indexer: 'ipca_spread',
        ratePercent: '6',
      });
      expect(isOk(supplied)).toBe(true);

      // The extract reads "CDI" but no rate. A per-column merge would pair the
      // extract's indexer with the user's rate: 6% of CDI.
      await withTenant(
        userId,
        async (tx) => {
          const repo = new DrizzleFixedIncomeContractRepository(tx, userId);
          await repo.upsertByAsset({
            assetId: cdb,
            indexer: 'cdi_percent',
            ratePercent: null,
            issueDate: BusinessDate.of('2026-01-10'),
            maturityDate: null,
            principal: null,
            source: ImportBatchId.of(BATCH),
          });
        },
        db,
      );

      const { rows } = await migratorPool.query<{ indexer: string; rate: string }>(
        'SELECT indexer, rate FROM fixed_income_contracts WHERE user_id = $1 AND asset_id = $2',
        [userId, cdb],
      );
      expect(rows[0]?.indexer).toBe('ipca_spread');
      expect(Number(rows[0]?.rate)).toBe(6);
    });
  });
});
