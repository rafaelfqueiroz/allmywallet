import { beforeEach, describe, expect, it } from 'vitest';
import type { TransactionId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { FakeTransactionRepository } from '@/core/ledger/test-support/fake-repositories';
import {
  TEST_USER_ID,
  aTransaction,
  assetIdFor,
  resetTransactionSequence,
} from '@/core/ledger/test-support/transaction-builder';
import type { Transaction } from '@/core/ledger/transaction';
import { allocateToWallet } from '@/core/wallets/allocate';
import {
  assignTransactionsToWallet,
  type AssignTransactionsDependencies,
} from '@/core/wallets/assign-transactions';
import { createWallet } from '@/core/wallets/create-wallet';
import { buildFakeDeps } from '@/core/wallets/test-support/build-deps';

/**
 * SPEC-006 BR-006-17 — "bulk operations: delete multiple, **assign multiple to
 * a wallet**", the half SPEC-006 delegates to SPEC-010.
 *
 * AC: "Bulk delete and bulk wallet assignment operate on a multi-selection."
 */

const PETR4 = assetIdFor('PETR4');
const ITSA4 = assetIdFor('ITSA4');

function build(rows: readonly Transaction[]): {
  deps: AssignTransactionsDependencies & ReturnType<typeof buildFakeDeps>;
  transactions: FakeTransactionRepository;
} {
  const wallet = buildFakeDeps();
  const transactions = new FakeTransactionRepository(rows);
  return { deps: { ...wallet, transactions }, transactions };
}

async function walletFor(deps: AssignTransactionsDependencies, name: string) {
  const result = await createWallet(deps, TEST_USER_ID, { name });
  if (!result.ok) throw new Error('setup failed');
  return result.value;
}

beforeEach(() => {
  resetTransactionSequence();
});

describe('the selection is read as the quantity it brought in', () => {
  it('assigns two assets from one multi-selection, in one call', async () => {
    const petrBuy = aTransaction().buy().of('PETR4').quantity('100').build();
    const itsaBuy = aTransaction().buy().of('ITSA4').quantity('50').build();
    const { deps } = build([petrBuy, itsaBuy]);
    deps.positionQuery.set(PETR4, Quantity.fromString('100'), Money.fromString('30'));
    deps.positionQuery.set(ITSA4, Quantity.fromString('50'), Money.fromString('10'));
    const wallet = await walletFor(deps, 'Aposentadoria');

    const result = await assignTransactionsToWallet(deps, TEST_USER_ID, {
      walletId: wallet.id,
      transactionIds: [petrBuy.id, itsaBuy.id],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assigned.map((a) => a.quantity.toString())).toEqual(['100', '50']);
    const allocations = await deps.allocations.listForWallet(wallet.id);
    expect(allocations).toHaveLength(2);
  });

  /**
   * The reason this nets rather than summing the acquiring rows: a selection
   * spanning a buy and a later partial sale brought in the difference, and
   * assigning the gross would claim shares that are no longer held.
   */
  it('nets a sale in the same selection against the buy', async () => {
    const buy = aTransaction().buy().of('PETR4').quantity('100').on('2026-01-05').build();
    const sell = aTransaction().sell().of('PETR4').quantity('30').on('2026-02-10').build();
    const { deps } = build([buy, sell]);
    // Held is deliberately larger than the selection's net: the user holds 200
    // in total, of which these two rows account for 70. With the sale ignored
    // the clamp would still leave room for 100, so a test where held equals
    // the net proves nothing about netting.
    deps.positionQuery.set(PETR4, Quantity.fromString('200'), Money.fromString('30'));
    const wallet = await walletFor(deps, 'Aposentadoria');

    const result = await assignTransactionsToWallet(deps, TEST_USER_ID, {
      walletId: wallet.id,
      transactionIds: [buy.id, sell.id],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assigned[0]?.quantity.toString()).toBe('70');
  });

  it('adds to the wallet rather than replacing what it already holds', async () => {
    const first = aTransaction().buy().of('PETR4').quantity('60').on('2026-01-05').build();
    const second = aTransaction().buy().of('PETR4').quantity('40').on('2026-02-05').build();
    const { deps } = build([first, second]);
    deps.positionQuery.set(PETR4, Quantity.fromString('100'), Money.fromString('30'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, TEST_USER_ID, {
      walletId: wallet.id,
      assetId: PETR4,
      quantity: Quantity.fromString('60'),
    });

    // `allocate.ts` spells out at length why the mode has to be named: read as
    // an absolute target, 40 would overwrite the 60 already there.
    const result = await assignTransactionsToWallet(deps, TEST_USER_ID, {
      walletId: wallet.id,
      transactionIds: [second.id],
    });

    expect(result.ok).toBe(true);
    const allocations = await deps.allocations.listForWallet(wallet.id);
    expect(allocations[0]?.quantity.toString()).toBe('100');
  });

  it('ignores rows that move no shares', async () => {
    const dividend = aTransaction().dividend().of('PETR4').quantity('0').price('1.50').build();
    const { deps } = build([dividend]);
    deps.positionQuery.set(PETR4, Quantity.fromString('100'), Money.fromString('30'));
    const wallet = await walletFor(deps, 'Aposentadoria');

    const result = await assignTransactionsToWallet(deps, TEST_USER_ID, {
      walletId: wallet.id,
      transactionIds: [dividend.id],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assigned).toEqual([]);
    expect(await deps.allocations.listForWallet(wallet.id)).toEqual([]);
  });

  /** BR-006-03 / DL-006-06: an `unclassified` row is stored and inert. */
  it('ignores an unclassified row', async () => {
    const staged = aTransaction().buy().of('PETR4').quantity('100').status('unclassified').build();
    const { deps } = build([staged]);
    deps.positionQuery.set(PETR4, Quantity.fromString('100'), Money.fromString('30'));
    const wallet = await walletFor(deps, 'Aposentadoria');

    const result = await assignTransactionsToWallet(deps, TEST_USER_ID, {
      walletId: wallet.id,
      transactionIds: [staged.id],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assigned).toEqual([]);
  });

  /**
   * A split scales the allocations themselves (`apply-corporate-event.ts`).
   * Counting its quantity here would assign shares the event already placed.
   */
  it('ignores a corporate event', async () => {
    const split = aTransaction().split().of('PETR4').ratio('2').build();
    const { deps } = build([split]);
    deps.positionQuery.set(PETR4, Quantity.fromString('200'), Money.fromString('15'));
    const wallet = await walletFor(deps, 'Aposentadoria');

    const result = await assignTransactionsToWallet(deps, TEST_USER_ID, {
      walletId: wallet.id,
      transactionIds: [split.id],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assigned).toEqual([]);
  });

  it('reads an adjustment from the sign of its quantity, as SPEC-005 BR-005-24 stores it', async () => {
    const buy = aTransaction().buy().of('PETR4').quantity('100').on('2026-01-05').build();
    const correction = aTransaction()
      .adjustment()
      .of('PETR4')
      .quantity('-25')
      .on('2026-02-01')
      .build();
    const { deps } = build([buy, correction]);
    deps.positionQuery.set(PETR4, Quantity.fromString('75'), Money.fromString('30'));
    const wallet = await walletFor(deps, 'Aposentadoria');

    const result = await assignTransactionsToWallet(deps, TEST_USER_ID, {
      walletId: wallet.id,
      transactionIds: [buy.id, correction.id],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assigned[0]?.quantity.toString()).toBe('75');
  });
});

describe('BR-010-05 — the sum invariant survives a bulk assignment', () => {
  it('clamps to what is unassigned instead of overshooting the held quantity', async () => {
    const buy = aTransaction().buy().of('PETR4').quantity('100').build();
    const { deps } = build([buy]);
    deps.positionQuery.set(PETR4, Quantity.fromString('100'), Money.fromString('30'));
    const retirement = await walletFor(deps, 'Aposentadoria');
    const trading = await walletFor(deps, 'Trading');
    await allocateToWallet(deps, TEST_USER_ID, {
      walletId: trading.id,
      assetId: PETR4,
      quantity: Quantity.fromString('80'),
    });

    const result = await assignTransactionsToWallet(deps, TEST_USER_ID, {
      walletId: retirement.id,
      transactionIds: [buy.id],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 20 free, 100 asked for — the 20 land and the shortfall is *reported*.
    expect(result.value.assigned[0]?.quantity.toString()).toBe('20');
    expect(result.value.skipped).toEqual([{ assetId: PETR4, reason: 'already_assigned' }]);
    const total =
      Number((await deps.allocations.listForWallet(retirement.id))[0]?.quantity.toString()) +
      Number((await deps.allocations.listForWallet(trading.id))[0]?.quantity.toString());
    expect(total).toBe(100);
  });

  it('skips an asset that is already fully allocated rather than failing the whole selection', async () => {
    const petrBuy = aTransaction().buy().of('PETR4').quantity('100').build();
    const itsaBuy = aTransaction().buy().of('ITSA4').quantity('50').build();
    const { deps } = build([petrBuy, itsaBuy]);
    deps.positionQuery.set(PETR4, Quantity.fromString('100'), Money.fromString('30'));
    deps.positionQuery.set(ITSA4, Quantity.fromString('50'), Money.fromString('10'));
    const retirement = await walletFor(deps, 'Aposentadoria');
    const trading = await walletFor(deps, 'Trading');
    await allocateToWallet(deps, TEST_USER_ID, { walletId: trading.id, assetId: PETR4 });

    const result = await assignTransactionsToWallet(deps, TEST_USER_ID, {
      walletId: retirement.id,
      transactionIds: [petrBuy.id, itsaBuy.id],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assigned).toHaveLength(1);
    expect(result.value.assigned[0]?.assetId).toBe(ITSA4);
    expect(result.value.skipped).toEqual([{ assetId: PETR4, reason: 'already_assigned' }]);
  });

  it('skips an asset whose selection nets to nothing', async () => {
    const buy = aTransaction().buy().of('PETR4').quantity('100').on('2026-01-05').build();
    const sell = aTransaction().sell().of('PETR4').quantity('100').on('2026-02-10').build();
    const { deps } = build([buy, sell]);
    deps.positionQuery.set(PETR4, Quantity.zero(), Money.zero());
    const wallet = await walletFor(deps, 'Aposentadoria');

    const result = await assignTransactionsToWallet(deps, TEST_USER_ID, {
      walletId: wallet.id,
      transactionIds: [buy.id, sell.id],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skipped).toEqual([{ assetId: PETR4, reason: 'no_quantity' }]);
  });

  it('takes the allocation lock before reading what is unassigned', async () => {
    const buy = aTransaction().buy().of('PETR4').quantity('100').build();
    const { deps } = build([buy]);
    deps.positionQuery.set(PETR4, Quantity.fromString('100'), Money.fromString('30'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    const before = deps.allocations.lockCount;

    await assignTransactionsToWallet(deps, TEST_USER_ID, {
      walletId: wallet.id,
      transactionIds: [buy.id],
    });

    // Once here, once inside `allocateToWallet` — re-entrant within the same
    // transaction, which is the point: the clamp cannot be stale.
    expect(deps.allocations.lockCount).toBeGreaterThan(before);
  });
});

describe('refusals', () => {
  it('refuses an empty selection', async () => {
    const { deps } = build([]);
    const wallet = await walletFor(deps, 'Aposentadoria');

    const result = await assignTransactionsToWallet(deps, TEST_USER_ID, {
      walletId: wallet.id,
      transactionIds: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('EMPTY_SELECTION');
  });

  it('refuses a wallet that does not exist', async () => {
    const buy = aTransaction().buy().of('PETR4').quantity('100').build();
    const { deps } = build([buy]);
    const stranger = await walletFor(deps, 'Aposentadoria');
    await deps.wallets.delete(stranger.id);

    const result = await assignTransactionsToWallet(deps, TEST_USER_ID, {
      walletId: stranger.id,
      transactionIds: [buy.id],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('WALLET_NOT_FOUND');
  });

  it('refuses the whole selection when one id is gone, writing nothing', async () => {
    const buy = aTransaction().buy().of('PETR4').quantity('100').build();
    const { deps } = build([buy]);
    deps.positionQuery.set(PETR4, Quantity.fromString('100'), Money.fromString('30'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    const missing = aTransaction().buy().of('ITSA4').build().id as TransactionId;

    const result = await assignTransactionsToWallet(deps, TEST_USER_ID, {
      walletId: wallet.id,
      transactionIds: [buy.id, missing],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TRANSACTION_NOT_FOUND');
    expect(await deps.allocations.listForWallet(wallet.id)).toEqual([]);
  });
});
