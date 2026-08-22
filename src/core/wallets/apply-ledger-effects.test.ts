import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { AssetId, TransactionId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type { Transaction, TransactionType } from '@/core/ledger/transaction';
import { allocateToWallet, computeUnassigned } from '@/core/wallets/allocate';
import { applyLedgerEffects } from '@/core/wallets/apply-ledger-effects';
import { createWallet } from '@/core/wallets/create-wallet';
import { setStandingRule } from '@/core/wallets/standing-rule';
import { buildFakeDeps } from '@/core/wallets/test-support/build-deps';

const USER = UserId.generate();
const ITSA4 = AssetId.generate();

async function walletFor(deps: ReturnType<typeof buildFakeDeps>, name: string) {
  const result = await createWallet(deps, USER, { name });
  if (!result.ok) throw new Error('setup failed');
  return result.value;
}

function tx(
  type: TransactionType,
  quantity: string,
  tradeDate: string,
  extra: Partial<Transaction> = {},
): Transaction {
  return {
    id: TransactionId.generate(),
    userId: USER,
    assetId: ITSA4,
    institutionId: null,
    type,
    status: 'active',
    tradeDate: BusinessDate.of(tradeDate),
    quantity: Quantity.fromString(quantity),
    unitPrice: Money.fromString('10'),
    fees: Money.zero(),
    ratio: null,
    totalValue: Money.fromString('100'),
    source: 'import',
    naturalKey: null,
    importBatchId: null,
    createdAt: new Date('2026-03-15T12:00:00Z'),
    updatedAt: new Date('2026-03-15T12:00:00Z'),
    ...extra,
  } as Transaction;
}

describe('SPEC-010 BR-010-10 — a committed buy reaches allocations', () => {
  it('auto-increments a single-wallet asset', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, USER, { walletId: wallet.id, assetId: ITSA4 });

    // Post-commit state: the ledger and the position cache already reflect the buy.
    deps.positionQuery.set(ITSA4, Quantity.fromString('120'), Money.fromString('10'));

    const result = await applyLedgerEffects(deps, USER, [tx('buy', '20', '2026-03-10')]);

    expect(result.ok).toBe(true);
    const allocations = await deps.allocations.listForWallet(wallet.id);
    expect(allocations[0]?.quantity.toString()).toBe('120');
  });

  it('BR-010-11 — leaves a split asset pending rather than distributing it', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const retirement = await walletFor(deps, 'Aposentadoria');
    const trading = await walletFor(deps, 'Trading');
    await allocateToWallet(deps, USER, {
      walletId: retirement.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('60'),
    });
    await allocateToWallet(deps, USER, {
      walletId: trading.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('40'),
    });
    deps.positionQuery.set(ITSA4, Quantity.fromString('120'), Money.fromString('10'));

    const result = await applyLedgerEffects(deps, USER, [tx('buy', '20', '2026-03-10')]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.allocations[0]?.outcome.kind).toBe('pending');
    // Untouched: 60/40, with the 20 sitting in Unassigned.
    expect((await deps.allocations.listForWallet(retirement.id))[0]?.quantity.toString()).toBe(
      '60',
    );
    expect((await deps.allocations.listForWallet(trading.id))[0]?.quantity.toString()).toBe('40');
  });

  it('BR-010-14 — a standing rule routes the purchase to the named wallet', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const retirement = await walletFor(deps, 'Aposentadoria');
    const trading = await walletFor(deps, 'Trading');
    await allocateToWallet(deps, USER, {
      walletId: retirement.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('60'),
    });
    await allocateToWallet(deps, USER, {
      walletId: trading.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('40'),
    });
    await setStandingRule(deps, USER, ITSA4, retirement.id);
    deps.positionQuery.set(ITSA4, Quantity.fromString('120'), Money.fromString('10'));

    const result = await applyLedgerEffects(deps, USER, [tx('buy', '20', '2026-03-10')]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.allocations[0]?.outcome.kind).toBe('standing_rule');
    expect((await deps.allocations.listForWallet(retirement.id))[0]?.quantity.toString()).toBe(
      '80',
    );
  });
});

describe('SPEC-010 BR-010-17 — a committed sell reduces allocations', () => {
  /**
   * The regression this whole module exists for. Before the wiring, a sell
   * shrank the position and left allocations at their old totals, so
   * `allocated (100) > held (60)` — BR-010-05 violated by an ordinary import.
   */
  it('reduces proportionally and keeps allocated ≤ held', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const retirement = await walletFor(deps, 'Aposentadoria');
    const trading = await walletFor(deps, 'Trading');
    await allocateToWallet(deps, USER, {
      walletId: retirement.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('60'),
    });
    await allocateToWallet(deps, USER, {
      walletId: trading.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('40'),
    });
    deps.positionQuery.set(ITSA4, Quantity.fromString('60'), Money.fromString('10'));

    const result = await applyLedgerEffects(deps, USER, [tx('sell', '40', '2026-03-10')]);

    expect(result.ok).toBe(true);
    // 40 sold from 100 leaves 60, split 60/40 → 36 and 24. Hand-computed.
    const retirementQty = (await deps.allocations.listForWallet(retirement.id))[0]?.quantity;
    const tradingQty = (await deps.allocations.listForWallet(trading.id))[0]?.quantity;
    expect(retirementQty?.toString()).toBe('36');
    expect(tradingQty?.toString()).toBe('24');

    const allocated =
      Number(retirementQty?.toString() ?? '0') + Number(tradingQty?.toString() ?? '0');
    expect(allocated).toBeLessThanOrEqual(60);
  });
});

describe('SPEC-010 BR-010-18 — corporate events scale allocations', () => {
  it('a 1:2 split doubles every wallet’s allocated quantity', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, USER, { walletId: wallet.id, assetId: ITSA4 });

    // Post-commit state, as everywhere else in this file: the ledger has
    // already replayed the split, so the position cache holds the doubled
    // quantity by the time allocations are adjusted. Seeding the *pre*-split
    // 100 here described a state that cannot occur, and the BR-010-05 check
    // at the end of the replay is what surfaced it.
    deps.positionQuery.set(ITSA4, Quantity.fromString('200'), Money.fromString('5'));

    const result = await applyLedgerEffects(deps, USER, [
      tx('split', '100', '2026-03-10', { ratio: Quantity.fromString('2') }),
    ]);

    expect(result.ok).toBe(true);
    expect((await deps.allocations.listForWallet(wallet.id))[0]?.quantity.toString()).toBe('200');
  });

  it('a split row carrying no ratio is skipped, never treated as 1:1', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, USER, { walletId: wallet.id, assetId: ITSA4 });

    const result = await applyLedgerEffects(deps, USER, [tx('split', '100', '2026-03-10')]);

    expect(result.ok).toBe(true);
    expect((await deps.allocations.listForWallet(wallet.id))[0]?.quantity.toString()).toBe('100');
  });
});

describe('SPEC-010 — ordering and inertness', () => {
  it('applies a split before a later buy, not all splits first', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, USER, { walletId: wallet.id, assetId: ITSA4 });
    deps.positionQuery.set(ITSA4, Quantity.fromString('250'), Money.fromString('10'));

    // Supplied out of order on purpose: the split is dated first and must be
    // applied first even though the buy arrives first in the array.
    const result = await applyLedgerEffects(deps, USER, [
      tx('buy', '50', '2026-03-20'),
      tx('split', '100', '2026-03-10', { ratio: Quantity.fromString('2') }),
    ]);

    expect(result.ok).toBe(true);
    // 100 → split ×2 → 200 → buy 50 auto-increments to the held 250.
    expect((await deps.allocations.listForWallet(wallet.id))[0]?.quantity.toString()).toBe('250');
  });

  it('BR-006-03 — an unclassified transaction changes no allocation', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, USER, { walletId: wallet.id, assetId: ITSA4 });

    const result = await applyLedgerEffects(deps, USER, [
      tx('buy', '20', '2026-03-10', { status: 'unclassified' }),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.allocations).toHaveLength(0);
    expect((await deps.allocations.listForWallet(wallet.id))[0]?.quantity.toString()).toBe('100');
  });

  it('a proventos row is not an allocation event', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, USER, { walletId: wallet.id, assetId: ITSA4 });

    const result = await applyLedgerEffects(deps, USER, [tx('dividend', '100', '2026-03-10')]);

    expect(result.ok).toBe(true);
    expect((await deps.allocations.listForWallet(wallet.id))[0]?.quantity.toString()).toBe('100');
  });

  it('an empty commit is a no-op success', async () => {
    const deps = buildFakeDeps();
    const result = await applyLedgerEffects(deps, USER, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.allocations).toEqual([]);
  });
});

describe('SPEC-010 BR-010-05 — the invariant holds across a whole batch, not at each step', () => {
  /**
   * A batch is applied against the position the ledger *already* holds — the
   * post-commit one. Checking "allocated ≤ held" after every individual
   * transaction therefore compares an intermediate allocation against a final
   * position, and a batch that ends valid can pass through a state that reads
   * invalid. A round trip is the ordinary case: buy 50, sell 50, net zero.
   *
   * The failure was not a wrong number. `applyBuy` returned
   * ALLOCATION_EXCEEDS_HOLDINGS, `handleImportCommit` propagated it, the
   * whole `withTenant` transaction rolled back, and pg-boss retried the same
   * deterministic failure forever — the batch could never commit at all.
   */
  it('a buy and a later sell of a fully-allocated asset commits', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, USER, { walletId: wallet.id, assetId: ITSA4 });

    // The batch nets to zero, so the cached position is unchanged at 100.
    const result = await applyLedgerEffects(deps, USER, [
      tx('buy', '50', '2026-03-02'),
      tx('sell', '50', '2026-03-20'),
    ]);

    expect(result.ok).toBe(true);
    expect((await deps.allocations.listForWallet(wallet.id))[0]?.quantity.toString()).toBe('100');
  });

  it('a batch that genuinely over-allocates is still refused', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, USER, { walletId: wallet.id, assetId: ITSA4 });

    // The position cache says 100 held, but the batch claims 60 more bought.
    const result = await applyLedgerEffects(deps, USER, [tx('buy', '60', '2026-03-02')]);

    expect(result.ok).toBe(false);
  });
});

describe('SPEC-010 BR-010-05/17 — every type that reduces the position reduces allocations', () => {
  /**
   * `sell` was the only reduction the replay knew about. `transfer_out` and a
   * negative `adjustment` both shrink the position in
   * `core/positions/apply-transaction.ts`, so leaving allocations untouched
   * left allocated > held — the exact violation this module was written to
   * close, still open on two paths.
   *
   * `computeUnassigned` filters to positive remainders, so the contradiction
   * did not even render: the wallets screen showed 100 allocated of an asset
   * the user no longer held, and Unassigned showed nothing at all.
   */
  it('a transfer_out of a fully-allocated asset reduces the allocation', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, USER, { walletId: wallet.id, assetId: ITSA4 });

    deps.positionQuery.set(ITSA4, Quantity.zero(), Money.fromString('10'));
    const result = await applyLedgerEffects(deps, USER, [tx('transfer_out', '100', '2026-03-10')]);

    expect(result.ok).toBe(true);
    expect(await deps.allocations.listForWallet(wallet.id)).toHaveLength(0);
  });

  it('a negative adjustment reduces allocations by the shares it removed', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, USER, { walletId: wallet.id, assetId: ITSA4 });

    // BR-005-24's reconciliation correction: B3 says 40 fewer shares.
    deps.positionQuery.set(ITSA4, Quantity.fromString('60'), Money.fromString('10'));
    const result = await applyLedgerEffects(deps, USER, [tx('adjustment', '-40', '2026-03-10')]);

    expect(result.ok).toBe(true);
    expect((await deps.allocations.listForWallet(wallet.id))[0]?.quantity.toString()).toBe('60');
  });

  it('a positive adjustment adds no allocation — the shares land in Unassigned', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, USER, { walletId: wallet.id, assetId: ITSA4 });

    deps.positionQuery.set(ITSA4, Quantity.fromString('140'), Money.fromString('10'));
    const result = await applyLedgerEffects(deps, USER, [tx('adjustment', '40', '2026-03-10')]);

    expect(result.ok).toBe(true);
    expect((await deps.allocations.listForWallet(wallet.id))[0]?.quantity.toString()).toBe('100');
    const unassigned = await computeUnassigned(deps, USER);
    expect(unassigned[0]?.quantity.toString()).toBe('40');
  });
});

/**
 * SPEC-010 BR-010-17 / AC-010-15 — "a sale with a specified wallet reduces
 * only that wallet".
 *
 * `applySell` has accepted a `walletId` since it was written, and every caller
 * passed none — so the branch was unit-tested in `apply-sell.test.ts` and
 * unreachable in the running product (#61). The rule was ticked as done on the
 * strength of a test for code nothing could invoke, which is the same pattern
 * `use-cases-have-callers.test.ts` exists to stop.
 */
describe('SPEC-010 AC-010-15 — a sale from a named wallet', () => {
  async function twoWallets() {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const retirement = await walletFor(deps, 'Aposentadoria');
    const trading = await walletFor(deps, 'Trading');
    // A deliberate 60/40 split (BR-010-04), which is the only case where
    // "which wallet sold" and "proportionally" give different answers.
    await allocateToWallet(deps, USER, {
      walletId: retirement.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('60'),
    });
    await allocateToWallet(deps, USER, {
      walletId: trading.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('40'),
    });
    return { deps, retirement, trading };
  }

  async function quantityIn(
    deps: ReturnType<typeof buildFakeDeps>,
    walletId: Parameters<typeof deps.allocations.listForWallet>[0],
  ) {
    const rows = await deps.allocations.listForWallet(walletId);
    return rows[0]?.quantity.toString() ?? '0';
  }

  it('reduces only the named wallet, leaving the other untouched', async () => {
    const { deps, retirement, trading } = await twoWallets();
    deps.positionQuery.set(ITSA4, Quantity.fromString('80'), Money.fromString('10'));

    const result = await applyLedgerEffects(deps, USER, [tx('sell', '20', '2026-03-10')], {
      soldFromWallet: trading.id,
    });

    expect(result.ok).toBe(true);
    expect(await quantityIn(deps, trading.id)).toBe('20');
    // The whole point: proportional would have taken 12 from here.
    expect(await quantityIn(deps, retirement.id)).toBe('60');
  });

  it('without a named wallet, the same sale reduces both proportionally', async () => {
    // The control. Identical setup and sale, no statement — so any difference
    // above is the option and not the fixture.
    const { deps, retirement, trading } = await twoWallets();
    deps.positionQuery.set(ITSA4, Quantity.fromString('80'), Money.fromString('10'));

    const result = await applyLedgerEffects(deps, USER, [tx('sell', '20', '2026-03-10')]);

    expect(result.ok).toBe(true);
    expect(await quantityIn(deps, retirement.id)).toBe('48');
    expect(await quantityIn(deps, trading.id)).toBe('32');
  });

  it('refuses a sale larger than the named wallet holds, rather than spilling into the others', async () => {
    // BR-010-17's refusal, and the reason it is a refusal: taking the excess
    // from another wallet would silently contradict the statement the user
    // just made about which shares were sold.
    const { deps, retirement, trading } = await twoWallets();
    deps.positionQuery.set(ITSA4, Quantity.fromString('50'), Money.fromString('10'));

    const result = await applyLedgerEffects(deps, USER, [tx('sell', '50', '2026-03-10')], {
      soldFromWallet: trading.id,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('WALLET_ALLOCATION_INSUFFICIENT');
    // Nothing was written on the way to the refusal.
    expect(await quantityIn(deps, retirement.id)).toBe('60');
    expect(await quantityIn(deps, trading.id)).toBe('40');
  });

  it('applies to a transfer_out as well as a sell', async () => {
    // Both are reductions that carry the same question; `REDUCING_TYPES`
    // routes them through the same call, so the statement has to reach both.
    const { deps, retirement, trading } = await twoWallets();
    deps.positionQuery.set(ITSA4, Quantity.fromString('90'), Money.fromString('10'));

    const result = await applyLedgerEffects(deps, USER, [tx('transfer_out', '10', '2026-03-10')], {
      soldFromWallet: retirement.id,
    });

    expect(result.ok).toBe(true);
    expect(await quantityIn(deps, retirement.id)).toBe('50');
    expect(await quantityIn(deps, trading.id)).toBe('40');
  });
});

/**
 * SPEC-014 BR-014-12 — **the allocation event log is dated by the trade, not
 * by the import.**
 *
 * This is the path where getting it wrong is invisible and total. A user's
 * first import carries four years of history and runs in one afternoon; if
 * these events were stamped with the clock, every provento paid before today
 * would be attributed to a wallet that the log says held nothing at the time,
 * and the Earnings report's wallet breakdown would read zero for every past
 * period — plausibly, and wrongly.
 */
describe('SPEC-014 BR-014-12 — allocation history follows the ledger, not the clock', () => {
  it('dates each event by the transaction that caused it', async () => {
    const deps = buildFakeDeps();
    const wallet = await walletFor(deps, 'Aposentadoria');
    await setStandingRule(deps, USER, ITSA4, wallet.id);

    deps.positionQuery.set(ITSA4, Quantity.fromString('150'), Money.fromString('10'));

    const result = await applyLedgerEffects(deps, USER, [
      tx('buy', '100', '2024-02-05'),
      tx('buy', '50', '2025-07-11'),
    ]);
    expect(result.ok).toBe(true);

    expect(deps.allocations.events.map((event) => event.effectiveOn)).toEqual([
      '2024-02-05',
      '2025-07-11',
    ]);
    expect(deps.allocations.events.every((event) => event.cause === 'buy')).toBe(true);
  });

  it('records the running quantity after each change, which is what the fold reads', async () => {
    const deps = buildFakeDeps();
    const wallet = await walletFor(deps, 'Aposentadoria');
    await setStandingRule(deps, USER, ITSA4, wallet.id);

    deps.positionQuery.set(ITSA4, Quantity.fromString('150'), Money.fromString('10'));

    await applyLedgerEffects(deps, USER, [
      tx('buy', '100', '2024-02-05'),
      tx('buy', '50', '2025-07-11'),
    ]);

    // Absolute state, not deltas: 100 then 150. A delta log would need the
    // previous quantity read under lock at every write, and one missed event
    // would corrupt every later answer rather than one of them.
    expect(deps.allocations.events.map((event) => event.quantity)).toEqual(['100', '150']);
  });

  it('records a sale that empties an allocation as zero, never as silence', async () => {
    const deps = buildFakeDeps();
    const wallet = await walletFor(deps, 'Aposentadoria');
    await setStandingRule(deps, USER, ITSA4, wallet.id);

    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    await applyLedgerEffects(deps, USER, [tx('buy', '100', '2024-02-05')]);

    deps.positionQuery.set(ITSA4, Quantity.zero(), Money.zero());
    await applyLedgerEffects(deps, USER, [tx('sell', '100', '2026-01-20')]);

    const last = deps.allocations.events.at(-1);
    expect(last?.quantity).toBe('0');
    expect(last?.effectiveOn).toBe('2026-01-20');
    expect(last?.cause).toBe('sale');
  });

  it('leaves no event for an unclassified row, which is inert everywhere else too', async () => {
    const deps = buildFakeDeps();
    const wallet = await walletFor(deps, 'Aposentadoria');
    await setStandingRule(deps, USER, ITSA4, wallet.id);

    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));

    // BR-006-03 / DL-006-06: stored, and deliberately inert.
    await applyLedgerEffects(deps, USER, [
      tx('buy', '100', '2024-02-05', { status: 'unclassified' }),
    ]);

    expect(deps.allocations.events).toEqual([]);
  });
});
