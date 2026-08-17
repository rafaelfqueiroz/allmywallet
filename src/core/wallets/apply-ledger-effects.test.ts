import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { AssetId, TransactionId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type { Transaction, TransactionType } from '@/core/ledger/transaction';
import { allocateToWallet } from '@/core/wallets/allocate';
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
