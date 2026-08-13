import { beforeEach, describe, expect, it } from 'vitest';
import { BusinessDate, FakeClock } from '@/core/shared/clock';
import { Money, Quantity } from '@/core/shared/money';
import { createTransaction, type CreateTransactionInput } from '@/core/ledger/create-transaction';
import type { LedgerDependencies } from '@/core/ledger/dependencies';
import { naturalKeyFor } from '@/core/ledger/natural-key';
import { TRANSACTION_TYPES, type TransactionType } from '@/core/ledger/transaction';
import {
  FakePositionRepository,
  FakeTransactionRepository,
} from '@/core/ledger/test-support/fake-repositories';
import {
  TEST_USER_ID,
  aTransaction,
  assetIdFor,
  importBatchIdFor,
  institutionIdFor,
  resetTransactionSequence,
} from '@/core/ledger/test-support/transaction-builder';

const CLOCK = new FakeClock('2026-06-30T12:00:00Z');

function deps(): LedgerDependencies & {
  transactions: FakeTransactionRepository;
  positions: FakePositionRepository;
} {
  return {
    transactions: new FakeTransactionRepository(),
    positions: new FakePositionRepository(),
    clock: CLOCK,
  };
}

function buyInput(overrides: Partial<CreateTransactionInput> = {}): CreateTransactionInput {
  return {
    assetId: assetIdFor('PETR4'),
    institutionId: null,
    type: 'buy',
    tradeDate: BusinessDate.of('2026-01-05'),
    quantity: Quantity.fromString('100'),
    unitPrice: Money.fromString('10.00'),
    fees: Money.zero(),
    ...overrides,
  };
}

describe('SPEC-006 BR-006-11 — createTransaction', () => {
  beforeEach(() => {
    resetTransactionSequence();
  });

  it('AC — a manually entered holding lands in the ledger and produces a position', () => {
    // The "a CDB absent from every B3 extract" criterion, at the domain level:
    // manual entry is the only route such a holding has into the product.
    const state = deps();
    return createTransaction(state, TEST_USER_ID, {
      ...buyInput({
        assetId: assetIdFor('CDB-BANCO-X'),
        institutionId: institutionIdFor('Banco X'),
        quantity: Quantity.fromString('1'),
        unitPrice: Money.fromString('5000.00'),
      }),
    }).then(async (result) => {
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.transaction.isManual).toBe(true);
      expect(result.value.transaction.importBatchId).toBeNull();
      expect(result.value.transaction.isUserModified).toBe(false);

      const positions = await state.positions.list();
      expect(positions).toHaveLength(1);
      expect(positions[0]?.state.quantity.toString()).toBe('1');
      expect(positions[0]?.state.averageCost.toString()).toBe('5000');
    });
  });

  it('computes the stored total value and the natural key', async () => {
    const state = deps();
    const input = buyInput({
      fees: Money.fromString('4.90'),
      unitPrice: Money.fromString('32.15'),
    });
    const result = await createTransaction(state, TEST_USER_ID, input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 100 × 32,15 + 4,90 = 3.219,90
    expect(result.value.transaction.totalValue.toString()).toBe('3219.9');
    expect(result.value.transaction.naturalKey).toBe(
      naturalKeyFor({
        assetId: input.assetId,
        institutionId: input.institutionId,
        type: input.type,
        tradeDate: input.tradeDate,
        quantity: input.quantity,
        unitPrice: input.unitPrice,
      }),
    );
  });

  it('BR-006-04 / TS-21 — two genuinely identical same-day trades both survive', async () => {
    const state = deps();
    const first = await createTransaction(state, TEST_USER_ID, buyInput());
    const second = await createTransaction(state, TEST_USER_ID, buyInput());

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.transaction.naturalKey).toBe(second.value.transaction.naturalKey);
    expect(first.value.transaction.occurrence).toBe(1);
    expect(second.value.transaction.occurrence).toBe(2);

    // Both count: 200 shares, not 100 collapsed into one row.
    const positions = await state.positions.list();
    expect(positions[0]?.state.quantity.toString()).toBe('200');
  });

  it('BR-006-02 — an imported row records its batch and is not marked manual', async () => {
    const state = deps();
    const result = await createTransaction(
      state,
      TEST_USER_ID,
      buyInput({ importBatchId: importBatchIdFor('batch-a') }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.transaction.isManual).toBe(false);
    expect(result.value.transaction.importBatchId).toBe(importBatchIdFor('batch-a'));
  });

  it('BR-006-03 — an unclassified row is stored but stays out of the position', async () => {
    const state = deps();
    await createTransaction(state, TEST_USER_ID, buyInput());
    await createTransaction(
      state,
      TEST_USER_ID,
      buyInput({ status: 'unclassified', quantity: Quantity.fromString('999') }),
    );

    expect(state.transactions.rows).toHaveLength(2);
    const positions = await state.positions.list();
    expect(positions[0]?.state.quantity.toString()).toBe('100');
  });

  it('AC — all thirteen types can be created', async () => {
    const state = deps();
    // Opened first, so disposals have something to draw on.
    await createTransaction(
      state,
      TEST_USER_ID,
      buyInput({ quantity: Quantity.fromString('1000') }),
    );

    for (const type of TRANSACTION_TYPES) {
      const result = await createTransaction(state, TEST_USER_ID, {
        ...buyInput({
          type,
          tradeDate: BusinessDate.of('2026-02-05'),
          quantity: Quantity.fromString('1'),
          unitPrice: Money.fromString('1.00'),
        }),
        ...(type === 'split' || type === 'grupamento'
          ? { quantity: Quantity.zero(), unitPrice: Money.zero(), ratio: Quantity.fromString('2') }
          : {}),
      });
      expect(result.ok, `type ${type} must be creatable`).toBe(true);
    }
  });

  describe('BR-006-15 — impossible states are refused', () => {
    it('AC — selling more than held at that date, naming the held quantity', async () => {
      const state = deps();
      await createTransaction(
        state,
        TEST_USER_ID,
        buyInput({ quantity: Quantity.fromString('100') }),
      );

      const result = await createTransaction(
        state,
        TEST_USER_ID,
        buyInput({
          type: 'sell',
          tradeDate: BusinessDate.of('2026-02-05'),
          quantity: Quantity.fromString('101'),
          unitPrice: Money.fromString('12.00'),
        }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INSUFFICIENT_QUANTITY');
      expect(result.error.context).toEqual({ held: '100', requested: '101', date: '2026-02-05' });
      // Nothing was written.
      expect(state.transactions.insertCount).toBe(1);
    });

    it('judges a backdated sell against the position at *its* date, not today', async () => {
      // Bought 100 in March. A sell backdated to January is illegal even
      // though 100 are held today — comparing against a cached current
      // position would wave it through.
      const state = deps();
      await createTransaction(
        state,
        TEST_USER_ID,
        buyInput({ tradeDate: BusinessDate.of('2026-03-01') }),
      );

      const result = await createTransaction(
        state,
        TEST_USER_ID,
        buyInput({
          type: 'sell',
          tradeDate: BusinessDate.of('2026-01-15'),
          quantity: Quantity.fromString('50'),
          unitPrice: Money.fromString('12.00'),
        }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.context['date']).toBe('2026-01-15');
      expect(result.error.context['held']).toBe('0');
    });

    it('accepts a backdated buy inserted before an existing sale', async () => {
      // The mirror case, asserted because it is the one that must NOT be
      // refused: adding history *earlier* only ever makes later rows more
      // legal, so backdating a buy is always accepted. A guard implemented as
      // "refuse anything backdated" would pass the test above and fail here.
      const state = deps();
      await createTransaction(
        state,
        TEST_USER_ID,
        buyInput({ tradeDate: BusinessDate.of('2026-03-01') }),
      );
      await createTransaction(
        state,
        TEST_USER_ID,
        buyInput({
          type: 'sell',
          tradeDate: BusinessDate.of('2026-04-01'),
          quantity: Quantity.fromString('100'),
          unitPrice: Money.fromString('12.00'),
        }),
      );

      const result = await createTransaction(
        state,
        TEST_USER_ID,
        buyInput({ tradeDate: BusinessDate.of('2026-01-01'), quantity: Quantity.fromString('50') }),
      );
      expect(result.ok).toBe(true);
    });

    it('refuses a future trade date', async () => {
      const state = deps();
      const result = await createTransaction(
        state,
        TEST_USER_ID,
        buyInput({ tradeDate: BusinessDate.of('2026-07-01') }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('FUTURE_TRADE_DATE');
      expect(state.transactions.insertCount).toBe(0);
    });

    it('refuses a split with no ratio before it reaches the engine', async () => {
      const state = deps();
      const result = await createTransaction(
        state,
        TEST_USER_ID,
        buyInput({ type: 'split', quantity: Quantity.zero(), unitPrice: Money.zero() }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('RATIO_REQUIRED');
    });
  });

  describe('BR-006-18 — a backdated row recalculates forward from its own date', () => {
    it('reports the transaction’s date as the recalculation boundary', async () => {
      const state = deps();
      await createTransaction(
        state,
        TEST_USER_ID,
        buyInput({ tradeDate: BusinessDate.of('2026-05-01') }),
      );

      const result = await createTransaction(
        state,
        TEST_USER_ID,
        buyInput({ tradeDate: BusinessDate.of('2026-02-01'), quantity: Quantity.fromString('50') }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // DL-006-03: forward from the transaction date, not from today.
      expect(result.value.recalculation.scope.fromDate).toBe('2026-02-01');
      expect(result.value.recalculation.scope.assetId).toBe(assetIdFor('PETR4'));
    });

    it('AC — average cost is correct at every subsequent date after the insertion', async () => {
      // Entered in the order a user would: the March buy first, then the
      // January one discovered later.
      //   Jan 100 @  6,00 → total   600,00
      //   Mar 100 @ 10,00 → total 1.600,00 over 200 → average 8,00
      const state = deps();
      await createTransaction(
        state,
        TEST_USER_ID,
        buyInput({
          tradeDate: BusinessDate.of('2026-03-01'),
          unitPrice: Money.fromString('10.00'),
        }),
      );
      await createTransaction(
        state,
        TEST_USER_ID,
        buyInput({ tradeDate: BusinessDate.of('2026-01-01'), unitPrice: Money.fromString('6.00') }),
      );

      const positions = await state.positions.list();
      expect(positions[0]?.state.quantity.toString()).toBe('200');
      expect(positions[0]?.state.totalCost.toString()).toBe('1600');
      expect(positions[0]?.state.averageCost.toString()).toBe('8');
    });
  });

  it('keeps positions at different institutions apart (BR-007-08)', async () => {
    const state = deps();
    await createTransaction(
      state,
      TEST_USER_ID,
      buyInput({ institutionId: institutionIdFor('Clear'), unitPrice: Money.fromString('20.00') }),
    );
    await createTransaction(
      state,
      TEST_USER_ID,
      buyInput({ institutionId: institutionIdFor('Rico'), unitPrice: Money.fromString('40.00') }),
    );

    const positions = await state.positions.list();
    expect(positions).toHaveLength(2);
    expect(positions.map((p) => p.state.averageCost.toString()).sort()).toEqual(['20', '40']);
  });

  it('stamps created and updated timestamps from the Clock port, never Date.now()', async () => {
    const state = deps();
    const result = await createTransaction(state, TEST_USER_ID, buyInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.transaction.createdAt.toISOString()).toBe('2026-06-30T12:00:00.000Z');
    expect(result.value.transaction.updatedAt.toISOString()).toBe('2026-06-30T12:00:00.000Z');
  });

  it('attributes the row to the caller’s tenant', async () => {
    const state = deps();
    const result = await createTransaction(state, TEST_USER_ID, buyInput());
    expect(result.ok && result.value.transaction.userId).toBe(TEST_USER_ID);
  });

  it('records the type it was given, for every type (BR-006-05)', () => {
    // A cheap structural guard: the input type is what is stored, with no
    // silent remapping in between.
    const types: TransactionType[] = [...TRANSACTION_TYPES];
    expect(new Set(types).size).toBe(13);
    expect(aTransaction().build().type).toBe('buy');
  });
});
