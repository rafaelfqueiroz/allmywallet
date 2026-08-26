import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { BusinessDate, FakeClock } from '@/core/shared/clock';
import type { AssetId, WalletId } from '@/core/shared/ids';
import { UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import {
  DrizzlePositionQueryRepository,
  DrizzleWalletAllocationRepository,
  DrizzleWalletAssetRuleRepository,
  DrizzleWalletRepository,
  DrizzleWalletTargetRepository,
} from '@/adapters/db/wallet-repository';
import { DrizzleAssetCatalogRepository } from '@/adapters/db/asset-catalog-repository';
import { DrizzlePositionRepository } from '@/adapters/db/position-repository';
import { allocateToWallet } from '@/core/wallets/allocate';
import { applyCorporateEventToAllocations } from '@/core/wallets/apply-corporate-event';
import { createWallet } from '@/core/wallets/create-wallet';
import type { WalletDependencies } from '@/core/wallets/dependencies';
import { buildWalletBalance, type BalanceHolding } from '@/core/wallets/balance';
import { setWalletTargets } from '@/core/wallets/targets';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers, resetWallets } from '../support/reset';
import { seedAsset } from '../support/ledger-fixtures';
import { seedUser } from '../support/users';

/**
 * SPEC-017 against **real Postgres** (TESTING §1).
 *
 * Two things here cannot be proven anywhere else. BR-017-04's 100 % invariant
 * lives in row-locking behaviour, so a fake that serialises everything by being
 * single-threaded would assert nothing; and `target_pct` crosses a
 * `NUMERIC(20,8)` boundary, which is where a percentage would become a float
 * if `src/db/numeric.ts` were ever bypassed.
 *
 * TS-03: the database is shared across suite files in CI, so this file
 * truncates what it depends on.
 */
describe('SPEC-017 — wallet targets (integration)', () => {
  let testDb: TestDatabase;
  let appPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;

  const userId = UserId.generate();
  const clock = new FakeClock('2026-03-15T12:00:00Z');
  let petr4: AssetId;
  let vale3: AssetId;
  let cdb: AssetId;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    await resetWallets(testDb.migrationUrl);
    await resetLedger(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
    await seedUser(testDb.migrationUrl, userId);
    petr4 = (await seedAsset(testDb.migrationUrl, 'PETR4', 'Petrobras PN')).id;
    vale3 = (await seedAsset(testDb.migrationUrl, 'VALE3', 'Vale ON')).id;
    cdb = (await seedAsset(testDb.migrationUrl, 'CDB-BANCO-2029', 'CDB Banco 2029', 'cdb')).id;

    // Enough connections for genuinely concurrent transactions.
    appPool = new Pool({ connectionString: testDb.appUrl, max: 8 });
    appDb = drizzle(appPool, { schema });
  }, 180_000);

  afterAll(async () => {
    await appPool.end();
    await testDb.stop();
  });

  beforeEach(async () => {
    await resetWallets(testDb.migrationUrl);
  });

  function buildDeps(
    tx: Parameters<Parameters<typeof appDb.transaction>[0]>[0],
  ): WalletDependencies {
    return {
      wallets: new DrizzleWalletRepository(tx, userId),
      allocations: new DrizzleWalletAllocationRepository(tx, userId),
      assetRules: new DrizzleWalletAssetRuleRepository(tx, userId),
      targets: new DrizzleWalletTargetRepository(tx, userId),
      positionQuery: new DrizzlePositionQueryRepository(tx),
      assetCatalog: new DrizzleAssetCatalogRepository(tx),
      clock,
    };
  }

  async function seedPosition(assetId: AssetId, quantity: string, averageCost: string) {
    await withTenant(
      userId,
      async (tx) => {
        const repo = new DrizzlePositionRepository(tx, userId);
        // `upsertMany` rather than `replaceAll`: several assets are seeded in
        // sequence and a wholesale replace would drop the ones before it.
        await repo.upsertMany([
          {
            assetId,
            institutionId: null,
            state: {
              quantity: Quantity.fromString(quantity),
              totalCost: Money.fromString(quantity).times(averageCost),
              averageCost: Money.fromString(averageCost),
              realizedGain: Money.zero(),
            },
          },
        ]);
      },
      appDb,
    );
  }

  /** A wallet holding every asset in `assetIds`, fully allocated. */
  async function walletHolding(name: string, assetIds: readonly AssetId[]): Promise<WalletId> {
    return withTenant(
      userId,
      async (tx) => {
        const deps = buildDeps(tx);
        const created = await createWallet(deps, userId, { name });
        if (!created.ok) throw new Error('setup failed');
        for (const assetId of assetIds) {
          const allocated = await allocateToWallet(deps, userId, {
            walletId: created.value.id,
            assetId,
          });
          if (!allocated.ok) throw new Error(`setup failed: ${allocated.error.code}`);
        }
        return created.value.id;
      },
      appDb,
    );
  }

  async function storedTargets(walletId: WalletId) {
    return withTenant(
      userId,
      (tx) => new DrizzleWalletTargetRepository(tx, userId).listForWallet(walletId),
      appDb,
    );
  }

  it('round-trips a target percentage through NUMERIC(20,8) as a Quantity, never a float', async () => {
    await seedPosition(petr4, '100', '30');
    await seedPosition(vale3, '100', '60');
    const walletId = await walletHolding('Aposentadoria', [petr4, vale3]);

    await withTenant(
      userId,
      (tx) =>
        setWalletTargets(buildDeps(tx), userId, {
          walletId,
          mode: 'manual',
          targets: [
            { assetId: petr4, targetPct: Quantity.fromString('33.33333333') },
            { assetId: vale3, targetPct: Quantity.fromString('66.66666667') },
          ],
        }),
      appDb,
    );

    const rows = await storedTargets(walletId);
    const total = rows.reduce((sum, row) => sum.plus(row.targetPct), Quantity.zero());
    // Exact, to the last stored decimal place. A float round trip would land
    // on 33.333333329999997 and this equality would fail.
    expect(total.toString()).toBe('100');
    expect(rows.map((row) => row.targetPct.toString()).sort()).toEqual([
      '33.33333333',
      '66.66666667',
    ]);
  });

  /**
   * BR-017-04 under genuine concurrency.
   *
   * Ten transactions race to define the *first* target set for one wallet.
   * `SELECT ... FOR UPDATE` locks only rows that exist, and at this moment
   * `wallet_targets` has none for this wallet — the phantom gap. The lock is
   * therefore taken on the **wallet row**, which always exists; without it the
   * ten delete-then-insert pairs would collide on
   * `wallet_targets_wallet_id_asset_id_key` and some would fail with a
   * duplicate-key fault rather than serialising.
   */
  it('AC — the 100 % invariant holds under CONCURRENT writes to the same wallet', async () => {
    await seedPosition(petr4, '100', '30');
    await seedPosition(vale3, '100', '60');
    const walletId = await walletHolding('Disputada', [petr4, vale3]);

    const splits = ['10', '20', '30', '40', '50', '60', '70', '80', '90', '25'];
    const results = await Promise.all(
      splits.map((petrPct) =>
        withTenant(
          userId,
          (tx) =>
            setWalletTargets(buildDeps(tx), userId, {
              walletId,
              mode: 'manual',
              targets: [
                { assetId: petr4, targetPct: Quantity.fromString(petrPct) },
                {
                  assetId: vale3,
                  targetPct: Quantity.fromString('100').minus(Quantity.fromString(petrPct)),
                },
              ],
            }),
          appDb,
        ),
      ),
    );

    // Every write is individually valid, so every one of them should land —
    // serialised, not refused. A failure here means the lock turned a
    // correctness mechanism into a liveness problem.
    expect(results.every((result) => result.ok)).toBe(true);

    // THE invariant, read straight back from the database: one row per asset,
    // and they total exactly 100. An interleaving would show three rows, or a
    // total that is some other pair's sum.
    const rows = await storedTargets(walletId);
    expect(rows).toHaveLength(2);
    expect(rows.reduce((sum, row) => sum.plus(row.targetPct), Quantity.zero()).toString()).toBe(
      '100',
    );

    // And the surviving set is one of the ten submitted, not a mix of two.
    const petrRow = rows.find((row) => row.assetId === petr4);
    expect(splits).toContain(petrRow?.targetPct.toString());
  }, 60_000);

  /**
   * BR-017-23 / AC-14 — a 10:1 split changes no target, and the wallet's
   * balance state is identical before and after.
   *
   * The mechanism is that BR-010-18 scales the allocation by the same ratio as
   * the position, so the wallet's *asset set* is untouched and a percentage of
   * an unchanged set is an unchanged percentage. Asserted end to end anyway,
   * because "targets are percentages so splits are free" is the kind of
   * reasoning that is true until somebody stores a derived share count.
   */
  it('AC-14 — a 10:1 split leaves the stored targets and the balance state identical', async () => {
    await seedPosition(petr4, '100', '30');
    await seedPosition(vale3, '100', '60');
    const walletId = await walletHolding('Aposentadoria', [petr4, vale3]);

    await withTenant(
      userId,
      (tx) =>
        setWalletTargets(buildDeps(tx), userId, {
          walletId,
          mode: 'manual',
          targets: [
            { assetId: petr4, targetPct: Quantity.fromString('40') },
            { assetId: vale3, targetPct: Quantity.fromString('60') },
          ],
        }),
      appDb,
    );

    const before = await balanceFor(walletId, [
      { assetId: petr4, quantity: '100', value: '4000' },
      { assetId: vale3, quantity: '100', value: '6000' },
    ]);

    // The split: 100 PETR4 become 1.000, each worth a tenth. The position and
    // the allocation move together (BR-010-18); the wallet's money does not.
    await seedPosition(petr4, '1000', '3');
    await withTenant(
      userId,
      (tx) =>
        applyCorporateEventToAllocations(
          buildDeps(tx),
          userId,
          petr4,
          Quantity.fromString('10'),
          BusinessDate.of('2026-03-16'),
        ),
      appDb,
    );

    const after = await balanceFor(walletId, [
      { assetId: petr4, quantity: '1000', value: '4000' },
      { assetId: vale3, quantity: '100', value: '6000' },
    ]);

    expect(await storedTargets(walletId)).toEqual(await storedTargets(walletId));
    expect((await storedTargets(walletId)).map((row) => row.targetPct.toString()).sort()).toEqual([
      '40',
      '60',
    ]);

    expect(after.rows.map((row) => row.currentPct?.toString())).toEqual(
      before.rows.map((row) => row.currentPct?.toString()),
    );
    expect(after.rows.map((row) => row.driftPp?.toString())).toEqual(
      before.rows.map((row) => row.driftPp?.toString()),
    );
    expect(after.outOfBalance).toBe(before.outOfBalance);
    expect(after.needsReview).toBe(before.needsReview);
  });

  /**
   * AC-16 — targets survive a full position rebuild (DM-4).
   *
   * `replaceAll` **is** what a rebuild does to `positions`: SPEC-007 replays
   * the ledger and overwrites the cache wholesale (`src/ops/rebuild-positions.ts`).
   * Nothing on that path so much as names `wallet_targets`, which is the real
   * guarantee — a target is the user's stated intent, not a derived figure, so
   * it is not the kind of thing a recomputation is allowed to touch. Asserted
   * rather than argued, because "the rebuild does not go near it" is a claim
   * about code that will keep changing.
   */
  it('AC-16 — a full position rebuild leaves the stored targets untouched', async () => {
    await seedPosition(petr4, '100', '30');
    await seedPosition(vale3, '100', '60');
    const walletId = await walletHolding('Aposentadoria', [petr4, vale3]);
    await withTenant(
      userId,
      (tx) =>
        setWalletTargets(buildDeps(tx), userId, {
          walletId,
          mode: 'manual',
          targets: [
            { assetId: petr4, targetPct: Quantity.fromString('40') },
            { assetId: vale3, targetPct: Quantity.fromString('60') },
          ],
        }),
      appDb,
    );
    const before = await storedTargets(walletId);

    await withTenant(
      userId,
      async (tx) => {
        const repo = new DrizzlePositionRepository(tx, userId);
        await repo.replaceAll([
          {
            assetId: petr4,
            institutionId: null,
            state: {
              quantity: Quantity.fromString('100'),
              totalCost: Money.fromString('3000'),
              averageCost: Money.fromString('30'),
              realizedGain: Money.zero(),
            },
          },
          {
            assetId: vale3,
            institutionId: null,
            state: {
              quantity: Quantity.fromString('100'),
              totalCost: Money.fromString('6000'),
              averageCost: Money.fromString('60'),
              realizedGain: Money.zero(),
            },
          },
        ]);
      },
      appDb,
    );

    expect(await storedTargets(walletId)).toEqual(before);
  });

  /**
   * BR-017-06 / AC-2 — equal weight recomputes with no write of any kind.
   *
   * The proof is that `wallet_targets` stays empty across the change: there is
   * no stored percentage to migrate, so an asset joining cannot leave a stale
   * one behind.
   */
  it('AC-2 — an asset joining an equal-weight wallet moves every target, writing nothing', async () => {
    await seedPosition(petr4, '100', '30');
    const walletId = await walletHolding('Igualitária', [petr4]);

    await withTenant(
      userId,
      (tx) => setWalletTargets(buildDeps(tx), userId, { walletId, mode: 'equal_weight' }),
      appDb,
    );
    expect(await storedTargets(walletId)).toEqual([]);

    const oneAsset = await balanceFor(walletId, [
      { assetId: petr4, quantity: '100', value: '3000' },
    ]);
    expect(oneAsset.rows.map((row) => row.targetPct.toString())).toEqual(['100']);

    // VALE3 is allocated to the same wallet, with no target write at all.
    await seedPosition(vale3, '100', '60');
    await withTenant(
      userId,
      (tx) => allocateToWallet(buildDeps(tx), userId, { walletId, assetId: vale3 }),
      appDb,
    );

    const twoAssets = await balanceFor(walletId, [
      { assetId: petr4, quantity: '100', value: '3000' },
      { assetId: vale3, quantity: '100', value: '6000' },
    ]);
    expect(twoAssets.rows.map((row) => row.targetPct.toString())).toEqual(['50', '50']);
    expect(await storedTargets(walletId)).toEqual([]);
  });

  /**
   * BR-017-09 / AC-6 end to end, with the asset class read from the real
   * catalog rather than a fake: the CDB is allocated to the wallet, carries no
   * target, and — the part that matters — is outside the denominator every
   * share is computed against.
   */
  it('AC-6 — a wallet holding a CDB and stocks targets the stocks only, and states the coverage', async () => {
    await seedPosition(petr4, '100', '30');
    await seedPosition(vale3, '100', '60');
    await seedPosition(cdb, '1', '4000');
    const walletId = await walletHolding('Mista', [petr4, vale3, cdb]);

    const result = await withTenant(
      userId,
      (tx) => setWalletTargets(buildDeps(tx), userId, { walletId, mode: 'equal_weight' }),
      appDb,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value.targetableAssetIds].sort()).toEqual([petr4, vale3].sort());
    expect(result.value.untargetableAssetIds).toEqual([cdb]);

    const balance = await balanceFor(walletId, [
      { assetId: petr4, quantity: '100', value: '3000' },
      { assetId: vale3, quantity: '100', value: '3000' },
      { assetId: cdb, quantity: '1', value: '4000', assetClass: 'cdb' },
    ]);

    expect(balance.rows).toHaveLength(2);
    // 3.000 of a 6.000 targeted total, not of the 10.000 wallet.
    expect(balance.rows.map((row) => row.currentPct?.toString())).toEqual(['50', '50']);
    expect(balance.targetedSharePct?.toString()).toBe('60');
  });

  it('BR-017-11 / AC-7 — a wallet holding only a CDB is refused a target set', async () => {
    await seedPosition(cdb, '1', '4000');
    const walletId = await walletHolding('Só renda fixa', [cdb]);

    const result = await withTenant(
      userId,
      (tx) => setWalletTargets(buildDeps(tx), userId, { walletId, mode: 'equal_weight' }),
      appDb,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('WALLET_HAS_NO_TARGETABLE_ASSETS');
  });

  /**
   * BR-017-21 / AC-13 — a stale quote yields an unavailable drift rather than
   * a computed one.
   *
   * The valuation itself is SPEC-009's and is exercised elsewhere; what this
   * asserts is that the *balance* respects the flag rather than quietly
   * computing over the price anyway.
   */
  it('AC-13 — an unusable price leaves the whole wallet’s drift unavailable', async () => {
    await seedPosition(petr4, '100', '30');
    await seedPosition(vale3, '100', '60');
    const walletId = await walletHolding('Com cotação velha', [petr4, vale3]);
    await withTenant(
      userId,
      (tx) => setWalletTargets(buildDeps(tx), userId, { walletId, mode: 'equal_weight' }),
      appDb,
    );

    const balance = await balanceFor(walletId, [
      { assetId: petr4, quantity: '100', value: '9000' },
      { assetId: vale3, quantity: '100', value: '1000', priceUsable: false },
    ]);

    expect(balance.unavailableReason).toBe('PRICE_UNUSABLE');
    expect(balance.unpricedAssetIds).toEqual([vale3]);
    expect(balance.rows.every((row) => row.driftPp === null)).toBe(true);
    // 90/10 against 50/50 would be 40 pp out — the figure that must not appear.
    expect(balance.outOfBalance).toBe(false);
  });

  /**
   * The wallet's balance, computed from its **real** stored mode and targets
   * plus a hand-supplied valuation.
   *
   * The valuation is supplied rather than read because SPEC-009's pricing is
   * not what these tests are about: seeding quotes, closes, calendars and
   * contracts to make a wallet worth R$ 6.000 would put the thing under test
   * three layers away. The seam it stands in for —
   * `app/(app)/wallets/balance-data.ts` mapping SPEC-011's holding set — is
   * exercised by the E2E journey.
   */
  async function balanceFor(
    walletId: WalletId,
    holdings: readonly {
      readonly assetId: AssetId;
      readonly quantity: string;
      readonly value: string;
      readonly assetClass?: BalanceHolding['assetClass'];
      readonly priceUsable?: boolean;
    }[],
  ) {
    return withTenant(
      userId,
      async (tx) => {
        const deps = buildDeps(tx);
        const wallet = await deps.wallets.findById(walletId);
        if (wallet === null) throw new Error('wallet vanished');
        const stored = await deps.targets.listForWallet(walletId);

        return buildWalletBalance({
          wallet,
          stored: stored.map((row) => ({ assetId: row.assetId, targetPct: row.targetPct })),
          holdings: holdings.map((holding) => ({
            assetId: holding.assetId,
            assetClass: holding.assetClass ?? 'stock',
            quantity: Quantity.fromString(holding.quantity),
            value: Money.fromString(holding.value),
            priceUsable: holding.priceUsable ?? true,
          })),
          tolerancePp: Quantity.fromString('5'),
        });
      },
      appDb,
    );
  }
});
