import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UserId, WalletId, type AssetId } from '@/core/shared/ids';
import { walletsNeedingAttention } from '@/core/wallets/balance';
import { DriftUnavailableReason } from '@/core/wallets/drift';
import { loadWalletBalances } from '@/app/(app)/wallets/balance-data';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers, resetWallets } from '../support/reset';
import { seedAsset } from '../support/ledger-fixtures';
import { seedUser } from '../support/users';

/**
 * SPEC-017 BR-017-10/13/16/17/21 through the **real loader**, against real
 * Postgres.
 *
 * The unit tests prove the arithmetic; this proves the seam. Everything
 * between a `latest_quotes` row and a wallet's drift figure lives in
 * `app/(app)/wallets/balance-data.ts` — SPEC-011's holding set, the wallet
 * slice, the fixed-income split, the price-usability judgement — and none of
 * it is exercised by a test that hands `buildWalletBalance` a hand-built
 * holding. A mapping that silently dropped the wallet id, or passed the whole
 * position instead of the allocated slice, would pass every unit test in this
 * spec.
 *
 * TS-03: the shared CI database is truncated in `beforeEach`.
 */
describe('SPEC-017 — the balance loader and the "Needs attention" queue (integration)', () => {
  let database: TestDatabase;
  let pool: Pool;

  const userId = UserId.generate();
  const walletId = WalletId.generate();
  let petr4: AssetId;
  let vale3: AssetId;
  let cdb: AssetId;

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.migrationUrl);
    await resetWallets(database.migrationUrl);
    await resetLedger(database.migrationUrl);
    await resetUsers(database.migrationUrl);
    await seedUser(database.migrationUrl, userId);

    petr4 = (await seedAsset(database.migrationUrl, 'PETR4', 'Petrobras PN')).id;
    vale3 = (await seedAsset(database.migrationUrl, 'VALE3', 'Vale ON')).id;
    cdb = (await seedAsset(database.migrationUrl, 'CDB-BANCO-2029', 'CDB Banco 2029', 'cdb')).id;

    pool = new Pool({ connectionString: database.migrationUrl, max: 4 });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await resetWallets(database.migrationUrl);
    await resetLedger(database.migrationUrl);
    await resetUsers(database.migrationUrl);
    await database.stop();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE wallet_targets, wallet_allocations, wallets CASCADE');
    await pool.query('DELETE FROM positions WHERE user_id = $1', [userId]);
    await pool.query('TRUNCATE latest_quotes CASCADE');
    await pool.query('DELETE FROM config_overrides WHERE user_id = $1', [userId]);
  });

  async function seedPosition(assetId: AssetId, quantity: string, averageCost: string) {
    await pool.query(
      `INSERT INTO positions
         (id, user_id, asset_id, institution_id, quantity, total_cost, average_cost, realized_gain)
       VALUES (gen_random_uuid(), $1, $2, NULL, $3, $4, $5, 0)`,
      [userId, assetId, quantity, String(Number(quantity) * Number(averageCost)), averageCost],
    );
  }

  async function seedQuote(assetId: AssetId, price: string) {
    await pool.query(
      `INSERT INTO latest_quotes (asset_id, price, quoted_at, fetched_at, source)
       VALUES ($1, $2, now(), now(), 'test')`,
      [assetId, price],
    );
  }

  async function seedWallet(mode: string, allocations: readonly [AssetId, string][]) {
    await pool.query(
      `INSERT INTO wallets (id, user_id, name, target_mode) VALUES ($1, $2, 'Aposentadoria', $3)`,
      [walletId, userId, mode],
    );
    for (const [assetId, quantity] of allocations) {
      await pool.query(
        `INSERT INTO wallet_allocations
           (id, user_id, wallet_id, asset_id, quantity, cost_basis_at_allocation)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, NULL)`,
        [userId, walletId, assetId, quantity],
      );
    }
  }

  /**
   * AC-6 / AC-10 in one pass, because they are the same denominator seen twice.
   *
   * By hand:
   *   PETR4  100 × R$ 90,00 = R$ 9.000   VALE3  100 × R$ 10,00 = R$ 1.000
   *   targeted total                     = R$ 10.000
   *   CDB    at cost                     = R$  5.000  (untargeted)
   *   wallet                             = R$ 15.000
   *   equal weight over two assets       = 50 % each
   *   PETR4  9.000 ÷ 10.000              = 90 %  →  +40 pp, past the 5 pp default
   *   coverage 10.000 ÷ 15.000           = 66,66…%
   */
  it('AC-6/AC-10 — an out-of-balance wallet reaches the queue, with fixed income outside the denominator', async () => {
    await seedPosition(petr4, '100', '30');
    await seedPosition(vale3, '100', '5');
    await seedPosition(cdb, '1', '5000');
    await seedQuote(petr4, '90');
    await seedQuote(vale3, '10');
    await seedWallet('equal_weight', [
      [petr4, '100'],
      [vale3, '100'],
      [cdb, '1'],
    ]);

    const { balances, tolerancePp } = await loadWalletBalances(userId);
    const balance = balances.find((row) => row.walletId === walletId);

    expect(tolerancePp.toString()).toBe('5');
    expect(balance?.targetedValue.toString()).toBe('10000');
    expect(balance?.walletValue.toString()).toBe('15000');
    expect(balance?.targetedSharePct?.toString().startsWith('66.66666666')).toBe(true);

    const petrRow = balance?.rows.find((row) => row.assetId === petr4);
    expect(petrRow?.currentPct?.toString()).toBe('90');
    expect(petrRow?.driftPp?.toString()).toBe('40');
    expect(petrRow?.outOfTolerance).toBe(true);

    // The CDB is in the wallet and out of the targets — stated, not hidden.
    expect(balance?.untargeted.map((row) => row.assetId)).toEqual([cdb]);

    // BR-017-17 / DL-017-08: the existing queue, not a new one.
    expect(walletsNeedingAttention(balances).map((row) => row.walletId)).toEqual([walletId]);
  });

  /**
   * AC-9 — the tolerance is the user's own number, and changing it changes
   * which assets flag with no deploy. Written as a `user`-level override,
   * which is exactly what the preferences screen writes.
   */
  it('AC-9 — widening wallets.drift_tolerance_pp takes the same wallet out of the queue', async () => {
    await seedPosition(petr4, '100', '30');
    await seedPosition(vale3, '100', '20');
    await seedQuote(petr4, '56');
    await seedQuote(vale3, '44');
    await seedWallet('equal_weight', [
      [petr4, '100'],
      [vale3, '100'],
    ]);

    // 56/44 against 50/50 — 6 pp out, just past the default of 5.
    const before = await loadWalletBalances(userId);
    expect(before.balances[0]?.outOfBalance).toBe(true);

    await pool.query(
      `INSERT INTO config_overrides (id, user_id, level, key, value)
       VALUES (gen_random_uuid(), $1, 'user', 'wallets.drift_tolerance_pp', $2::jsonb)`,
      [userId, '10'],
    );

    const after = await loadWalletBalances(userId);
    expect(after.tolerancePp.toString()).toBe('10');
    expect(after.balances[0]?.outOfBalance).toBe(false);
    expect(walletsNeedingAttention(after.balances)).toEqual([]);
  });

  /**
   * AC-13 / BR-017-21 — a targeted asset nothing could price makes the whole
   * wallet's drift unavailable rather than a figure computed over a
   * denominator that is missing a part of itself.
   *
   * VALE3 gets no quote and no close, so SPEC-009 values it at cost and marks
   * it `PRICE_UNAVAILABLE` (DL-009-05). That is deliberate rather than a stale
   * `quoted_at`: staleness depends on whether B3's session happens to be open
   * when the suite runs, and a test whose outcome moves with the clock proves
   * nothing. The staleness rule itself is asserted directly in
   * `core/wallets/drift.test.ts`.
   */
  it('AC-13 — an unpriceable targeted asset leaves the wallet’s drift unavailable', async () => {
    await seedPosition(petr4, '100', '30');
    await seedPosition(vale3, '100', '20');
    await seedQuote(petr4, '90');
    await seedWallet('equal_weight', [
      [petr4, '100'],
      [vale3, '100'],
    ]);

    const { balances } = await loadWalletBalances(userId);
    const balance = balances.find((row) => row.walletId === walletId);

    expect(balance?.unavailableReason).toBe(DriftUnavailableReason.PRICE_UNUSABLE);
    expect(balance?.unpricedAssetIds).toEqual([vale3]);
    expect(balance?.rows.every((row) => row.driftPp === null && row.gap === null)).toBe(true);
    // PETR4 alone would read 81,8 % against 50 % — the figure that must not
    // appear, and the reason the refusal propagates to the denominator.
    expect(balance?.outOfBalance).toBe(false);
    expect(walletsNeedingAttention(balances)).toEqual([]);
  });

  /**
   * BR-017-12 — an unassigned holding is in no wallet, so it never enters a
   * target set nor the denominator a wallet's shares divide by.
   */
  it('BR-017-12 — the unallocated remainder stays out of the wallet’s figures', async () => {
    await seedPosition(petr4, '100', '30');
    await seedQuote(petr4, '90');
    // Only 40 of the 100 held shares are filed in the wallet.
    await seedWallet('equal_weight', [[petr4, '40']]);

    const { balances } = await loadWalletBalances(userId);
    const balance = balances.find((row) => row.walletId === walletId);

    // 40 × R$ 90, not 100 × R$ 90 — the wallet's own slice (SPEC-010 BR-010-04).
    expect(balance?.targetedValue.toString()).toBe('3600');
    expect(balance?.rows).toHaveLength(1);
    expect(balance?.rows[0]?.currentPct?.toString()).toBe('100');
  });

  it('BR-017-01 — a wallet with no targets declares none and is not in the queue', async () => {
    await seedPosition(petr4, '100', '30');
    await seedQuote(petr4, '90');
    await seedWallet('none', [[petr4, '100']]);

    const { balances } = await loadWalletBalances(userId);
    const balance = balances.find((row) => row.walletId === walletId);

    expect(balance?.mode).toBe('none');
    expect(balance?.rows).toEqual([]);
    expect(balance?.outOfBalance).toBe(false);
    expect(walletsNeedingAttention(balances)).toEqual([]);
  });
});
