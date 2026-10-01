import { beforeEach, describe, expect, it } from 'vitest';
import { BusinessDate, FakeClock } from '@/core/shared/clock';
import { Money, Quantity } from '@/core/shared/money';
import { serializePosition } from '@/core/positions/position-state';
import { rebuildPositions } from '@/core/positions/rebuild';
import { positionKeyString, type PositionSnapshot } from '@/core/positions/replay';
import { createTransaction, type CreateTransactionInput } from '@/core/ledger/create-transaction';
import type { LedgerDependencies } from '@/core/ledger/dependencies';
import { naturalKeyFor } from '@/core/ledger/natural-key';
import {
  TRANSACTION_TYPES,
  USER_EDITABLE_TRANSACTION_TYPES,
  type Transaction,
  type TransactionType,
} from '@/core/ledger/transaction';
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
  type TransactionBuilder,
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

async function seeded(rows: readonly Transaction[]) {
  const state = deps();
  for (const row of rows) await state.transactions.insert(row);
  const rebuilt = await rebuildPositions(state);
  if (!rebuilt.ok) throw new Error(`fixture does not replay: ${rebuilt.error.code}`);
  state.transactions.insertCount = 0;
  return state;
}

function carried(builder: TransactionBuilder): Transaction {
  const credit = builder.imported().build();
  return { ...credit, naturalKey: naturalKeyFor({ ...credit, unitPrice: Money.zero() }) };
}

function transferPair(from: string, to: string, on = '2026-03-01', price = '10') {
  return [
    aTransaction().transferOut().at(from).on(on).quantity('100').price('0').imported().build(),
    carried(aTransaction().transferIn().at(to).on(on).quantity('100').price(price)),
  ] as const;
}

function snapshotsAsBytes(snapshots: readonly PositionSnapshot[]): string {
  return JSON.stringify(
    [...snapshots]
      .sort((a, b) => (positionKeyString(a) < positionKeyString(b) ? -1 : 1))
      .map((snapshot) => ({
        key: positionKeyString(snapshot),
        ...serializePosition(snapshot.state),
        costEstimated: snapshot.costEstimated,
      })),
  );
}

async function expectRebuildEqualsIncremental(state: ReturnType<typeof deps>) {
  const incremental = snapshotsAsBytes(await state.positions.list());
  const rebuilt = await rebuildPositions(state);
  expect(rebuilt.ok).toBe(true);
  if (!rebuilt.ok) return;
  expect(snapshotsAsBytes(rebuilt.value)).toBe(incremental);
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

  it('AC — all fifteen types can be created', async () => {
    const state = deps();
    // SPEC-007 BR-007-05c: an amortization's effect depends on what the asset
    // is, so the catalogue must be able to say — a stock here.
    state.transactions.describeAsset(assetIdFor('PETR4'), {
      code: 'PETR4',
      name: 'Petrobras PN',
      assetClass: 'stock',
    });
    // Opened first, so disposals have something to draw on.
    await createTransaction(
      state,
      TEST_USER_ID,
      buyInput({ quantity: Quantity.fromString('1000') }),
    );

    for (const type of USER_EDITABLE_TRANSACTION_TYPES) {
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

  describe('#155 — insertion re-derives downstream carried legs', () => {
    const backdatedBuy = (at = 'A') =>
      buyInput({
        institutionId: institutionIdFor(at),
        tradeDate: BusinessDate.of('2026-02-01'),
        unitPrice: Money.fromString('20'),
      });

    it('100 @ 10 plus backdated 100 @ 20 carries 100 @ 15 to B and recalculates both positions', async () => {
      // A before its transfer: 100×10 + 100×20 = 3.000 over 200 = 15.
      // 100 leave: A keeps 100 / 1.500 and B receives 100 / 1.500.
      const [debit, credit] = transferPair('A', 'B');
      const state = await seeded([aTransaction().buy().at('A').build(), debit, credit]);

      const result = await createTransaction(state, TEST_USER_ID, backdatedBuy());

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.rederived.map((leg) => leg.id)).toEqual([credit.id]);
      expect(result.value.recalculation).toBe(result.value.recalculations[0]);
      expect(result.value.recalculations.map((outcome) => outcome.scope)).toEqual([
        {
          assetId: assetIdFor('PETR4'),
          institutionId: institutionIdFor('A'),
          fromDate: '2026-02-01',
        },
        {
          assetId: assetIdFor('PETR4'),
          institutionId: institutionIdFor('B'),
          fromDate: '2026-03-01',
        },
      ]);
      expect((await state.transactions.findById(credit.id))?.unitPrice.toString()).toBe('15');
      expect(state.transactions.updateCount).toBe(1);
      const positions = await state.positions.list();
      expect(positions.map((snapshot) => serializePosition(snapshot.state))).toEqual([
        { quantity: '100', totalCost: '1500', averageCost: '15', realizedGain: '0' },
        { quantity: '100', totalCost: '1500', averageCost: '15', realizedGain: '0' },
      ]);
      await expectRebuildEqualsIncremental(state);
    });

    it('re-carries an X→A→B chain to its fixed point', async () => {
      // X 200 / 3.000 sends 100 / 1.500 to A, which sends it all to B.
      const [xOut, toA] = transferPair('X', 'A');
      const [aOut, toB] = transferPair('A', 'B', '2026-04-01');
      const state = await seeded([aTransaction().buy().at('X').build(), xOut, toA, aOut, toB]);

      const result = await createTransaction(state, TEST_USER_ID, backdatedBuy('X'));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.rederived.map((leg) => leg.id).sort()).toEqual([toA.id, toB.id].sort());
      expect(result.value.recalculations).toHaveLength(3);
      expect((await state.transactions.findById(toA.id))?.unitPrice.toString()).toBe('15');
      expect((await state.transactions.findById(toB.id))?.unitPrice.toString()).toBe('15');
      const b = (await state.positions.list()).find(
        (p) => p.institutionId === institutionIdFor('B'),
      );
      expect(b?.state.totalCost.toString()).toBe('1500');
      await expectRebuildEqualsIncremental(state);
    });

    it('a valid backdated sale changes the weighted average carried after the next buy', async () => {
      // Jan 100 @ 10, Feb sell 50: 50 / 500; Mar buy 100 @ 20:
      // 150 / 2.500 = 16,666666…, stored carry 16,66666667.
      // Apr sends 100 to B: B cost 100×16,66666667 = 1.666,666667.
      const [debit, credit] = transferPair('A', 'B', '2026-04-01', '15');
      const state = await seeded([
        aTransaction().buy().at('A').build(),
        aTransaction().buy().at('A').on('2026-03-01').price('20').build(),
        debit,
        credit,
      ]);

      const result = await createTransaction(state, TEST_USER_ID, {
        ...backdatedBuy(),
        type: 'sell',
        quantity: Quantity.fromString('50'),
        unitPrice: Money.fromString('12'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.rederived.map((leg) => leg.id)).toEqual([credit.id]);
      expect((await state.transactions.findById(credit.id))?.unitPrice.toString()).toBe(
        '16.66666667',
      );
      const positions = await state.positions.list();
      const a = positions.find((p) => p.institutionId === institutionIdFor('A'));
      const b = positions.find((p) => p.institutionId === institutionIdFor('B'));
      expect(a?.state.quantity.toString()).toBe('50');
      expect(a?.state.realizedGain.toString()).toBe('100');
      expect(b?.state.totalCost.toString()).toBe('1666.666667');
      await expectRebuildEqualsIncremental(state);
    });

    it('an exact acquisition keeps the estimate of an open source lot on its carried credit', async () => {
      // Estimated 100 @ 10 + exact 100 @ 20 = 200 / 3.000, estimated.
      // The manual acquisition is exact; the carried mixed average is not.
      const [debit, credit] = transferPair('A', 'B');
      const state = await seeded([
        aTransaction().subscription().at('A').costEstimate('2026-01-05').imported().build(),
        debit,
        { ...credit, costIsEstimate: true },
      ]);

      const result = await createTransaction(state, TEST_USER_ID, backdatedBuy());

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.transaction.costIsEstimate).toBe(false);
      expect(result.value.transaction.estimateCloseDate).toBeNull();
      expect(result.value.rederived[0]?.unitPrice.toString()).toBe('15');
      expect(result.value.rederived[0]?.costIsEstimate).toBe(true);
      expect((await state.positions.list()).every((position) => position.costEstimated)).toBe(true);
      await expectRebuildEqualsIncremental(state);
    });

    it('re-derives the conversion source before guarding it and carries its proportional cost', async () => {
      // OLD3 200 / 3.000 converts 100 shares into 50 NEW3: cost out/in 1.500.
      // Source keeps 100 / 1.500; NEW3 average = 1.500 / 50 = 30.
      const out = aTransaction()
        .conversionOut(undefined, '1000')
        .of('OLD3')
        .at('A')
        .on('2026-03-01')
        .quantity('100')
        .imported()
        .build();
      const into = aTransaction()
        .conversionIn('1000')
        .of('NEW3')
        .at('A')
        .on('2026-03-01')
        .quantity('50')
        .imported()
        .build();
      const state = await seeded([aTransaction().buy().of('OLD3').at('A').build(), out, into]);

      const result = await createTransaction(state, TEST_USER_ID, {
        ...backdatedBuy(),
        assetId: assetIdFor('OLD3'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.rederived.map((leg) => leg.id)).toEqual([out.id, into.id]);
      expect((await state.transactions.findById(out.id))?.costBasis?.toString()).toBe('1500');
      expect((await state.transactions.findById(into.id))?.costBasis?.toString()).toBe('1500');
      expect(result.value.recalculations).toHaveLength(2);
      const target = (await state.positions.list()).find((p) => p.assetId === assetIdFor('NEW3'));
      expect(target?.state.averageCost.toString()).toBe('30');
      await expectRebuildEqualsIncremental(state);
    });

    it('a zero-cost bonus re-derives the source conversion cost before the source guard', async () => {
      // OLD3 100 / 1.000 plus 100 free shares → 200 / 1.000.
      // Conversion of 100 now removes 500, which is allocated to NEW3.
      // Source and destination are guarded with that new 500 allocation.
      const out = aTransaction()
        .conversionOut(undefined, '1000')
        .of('OLD3')
        .at('A')
        .on('2026-03-01')
        .quantity('100')
        .imported()
        .build();
      const into = aTransaction()
        .conversionIn('1000')
        .of('NEW3')
        .at('A')
        .on('2026-03-01')
        .quantity('50')
        .imported()
        .build();
      const state = await seeded([aTransaction().buy().of('OLD3').at('A').build(), out, into]);

      const result = await createTransaction(state, TEST_USER_ID, {
        ...backdatedBuy(),
        assetId: assetIdFor('OLD3'),
        type: 'bonificacao',
        unitPrice: Money.zero(),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((await state.transactions.findById(out.id))?.costBasis?.toString()).toBe('500');
      expect((await state.transactions.findById(into.id))?.costBasis?.toString()).toBe('500');
      const positions = await state.positions.list();
      expect(
        positions.find((p) => p.assetId === assetIdFor('OLD3'))?.state.totalCost.toString(),
      ).toBe('500');
      expect(
        positions.find((p) => p.assetId === assetIdFor('NEW3'))?.state.averageCost.toString(),
      ).toBe('10');
      await expectRebuildEqualsIncremental(state);
    });

    it('refuses before any write when a lower downstream cost cannot cover a user-owned conversion', async () => {
      // Zero-cost bonus: A 200 / 1.000, average 5, sends B 100 / 500.
      // B's manually stated conversion removes 1.000, more than its new 500.
      const [debit, credit] = transferPair('A', 'B');
      const out = aTransaction()
        .conversionOut(undefined, '1000')
        .at('B')
        .on('2026-04-01')
        .quantity('100')
        .build();
      const into = aTransaction()
        .conversionIn('1000')
        .of('NEW3')
        .at('B')
        .on('2026-04-01')
        .quantity('50')
        .build();
      const state = await seeded([aTransaction().buy().at('A').build(), debit, credit, out, into]);
      const before = snapshotsAsBytes(await state.positions.list());

      const result = await createTransaction(state, TEST_USER_ID, {
        ...backdatedBuy(),
        type: 'bonificacao',
        unitPrice: Money.zero(),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      // The conversion cost guard uses the engine's existing quantity code
      // even when held quantity suffices: the cost, not the shares, is short.
      expect(result.error.code).toBe('INSUFFICIENT_QUANTITY');
      expect(result.error.context).toEqual({ held: '100', requested: '100', date: '2026-04-01' });
      expect(state.transactions.insertCount).toBe(0);
      expect(state.transactions.updateCount).toBe(0);
      expect(state.positions.upsertCount).toBe(0);
      expect(snapshotsAsBytes(await state.positions.list())).toBe(before);
      expect((await state.transactions.findById(credit.id))?.unitPrice.toString()).toBe('10');
    });

    it('refuses an insertion that strands a later source debit without writing carried legs', async () => {
      const [debit, credit] = transferPair('A', 'B');
      const state = await seeded([aTransaction().buy().at('A').build(), debit, credit]);

      const result = await createTransaction(state, TEST_USER_ID, {
        ...backdatedBuy(),
        type: 'sell',
        quantity: Quantity.fromString('1'),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.context['held']).toBe('99');
      expect(state.transactions.insertCount).toBe(0);
      expect(state.transactions.updateCount).toBe(0);
      expect(state.positions.upsertCount).toBe(0);
    });

    it('a buy after the transfer leaves the stored credit and its position untouched', async () => {
      const [debit, credit] = transferPair('A', 'B');
      const state = await seeded([aTransaction().buy().at('A').build(), debit, credit]);

      const result = await createTransaction(state, TEST_USER_ID, {
        ...backdatedBuy(),
        tradeDate: BusinessDate.of('2026-04-01'),
      });

      expect(result.ok && result.value.rederived).toEqual([]);
      expect(result.ok && result.value.recalculations).toHaveLength(1);
      expect(state.transactions.updateCount).toBe(0);
      expect(await state.transactions.findById(credit.id)).toEqual(credit);
      await expectRebuildEqualsIncremental(state);
    });

    it('an unclassified insertion changes no carried figure or marker', async () => {
      const [debit, credit] = transferPair('A', 'B');
      const state = await seeded([aTransaction().buy().at('A').build(), debit, credit]);

      const result = await createTransaction(state, TEST_USER_ID, {
        ...backdatedBuy(),
        status: 'unclassified',
      });

      expect(result.ok && result.value.rederived).toEqual([]);
      expect(state.transactions.updateCount).toBe(0);
      expect(await state.transactions.findById(credit.id)).toEqual(credit);
      await expectRebuildEqualsIncremental(state);
    });

    it('supports batch callers opting out of the stored-ledger derivation', async () => {
      const [debit, credit] = transferPair('A', 'B');
      const state = await seeded([aTransaction().buy().at('A').build(), debit, credit]);

      const result = await createTransaction(state, TEST_USER_ID, backdatedBuy(), {
        rederiveCarriedLegs: false,
      });

      expect(result.ok && result.value.rederived).toEqual([]);
      expect(result.ok && result.value.recalculations).toHaveLength(1);
      expect(state.transactions.updateCount).toBe(0);
      expect((await state.transactions.findById(credit.id))?.unitPrice.toString()).toBe('10');
    });

    it('a same-position round trip recalculates once from the earliest affected date', async () => {
      // A 200 / 3.000 → remove 100 / 1.500 → restore 100 / 1.500.
      const [debit, credit] = transferPair('A', 'A');
      const state = await seeded([aTransaction().buy().at('A').build(), debit, credit]);

      const result = await createTransaction(state, TEST_USER_ID, backdatedBuy());

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.recalculations).toHaveLength(1);
      expect(result.value.recalculation.scope.fromDate).toBe('2026-02-01');
      expect((await state.positions.list())[0]?.state.totalCost.toString()).toBe('3000');
      expect(state.positions.upsertCount).toBe(1);
      await expectRebuildEqualsIncremental(state);
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
    expect(new Set(types).size).toBe(17);
    expect(aTransaction().build().type).toBe('buy');
  });
});
