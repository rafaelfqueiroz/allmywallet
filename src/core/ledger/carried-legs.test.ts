import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@/core/shared/clock';
import { asStored, Money } from '@/core/shared/money';
import { serializePosition } from '@/core/positions/position-state';
import { rebuildPositions } from '@/core/positions/rebuild';
import { positionKeyString, replayPositions, type PositionSnapshot } from '@/core/positions/replay';
import { bulkDeleteTransactions } from '@/core/ledger/bulk-delete-transactions';
import {
  planCarriedLegUpdates,
  positionsOf,
  rederiveCarriedLegs,
} from '@/core/ledger/carried-legs';
import { deleteTransaction, describeDeletionImpact } from '@/core/ledger/delete-transaction';
import type { LedgerDependencies } from '@/core/ledger/dependencies';
import { editTransaction, editTransactions } from '@/core/ledger/edit-transaction';
import { naturalKeyFor } from '@/core/ledger/natural-key';
import type { Transaction } from '@/core/ledger/transaction';
import {
  FakePositionRepository,
  FakeTransactionRepository,
} from '@/core/ledger/test-support/fake-repositories';
import {
  aTransaction,
  assetIdFor,
  institutionIdFor,
  resetTransactionSequence,
  type TransactionBuilder,
} from '@/core/ledger/test-support/transaction-builder';
import type { AmortizationTerms } from '@/core/positions/amortization';

/** SPEC-007 BR-007-05c: these ledgers hold no amortization, so no asset needs terms. */
const NO_AMORTIZATION: AmortizationTerms = new Map();

/**
 * SPEC-007 BR-007-06 (amended 2026-09-21) — #144 review F6. The AC: "A
 * position including an estimated subscription cost reads as estimated … through
 * transfers and conversions, until it closes; editing the price clears it."
 *
 * The carried legs downstream of an edited or deleted row are re-derived with
 * it — cost and marker together, by import's own rule — so correcting the
 * price at the source clears the marker wherever it travelled.
 *
 * Every fixture is generated (DV-24). The XPML11 shape throughout: 20 quotas
 * subscribed, priced at a 114,90 close, the real price 112,95.
 */

const CLOCK = new FakeClock('2026-06-30T12:00:00Z');
const NOW = CLOCK.now();

function deps(rows: readonly Transaction[]): LedgerDependencies & {
  transactions: FakeTransactionRepository;
  positions: FakePositionRepository;
} {
  return {
    transactions: new FakeTransactionRepository(rows),
    positions: new FakePositionRepository(),
    clock: CLOCK,
  };
}

/** A cache built from the ledger, as the incremental path would have left it. */
async function seeded(rows: readonly Transaction[]) {
  const state = deps(rows);
  const rebuilt = await rebuildPositions(state);
  if (!rebuilt.ok) throw new Error(`fixture does not replay: ${rebuilt.error.code}`);
  return state;
}

/**
 * An import-written, price-less credit carrying `price`: keyed at the price B3
 * stated — none — as SPEC-005 BR-005-17 keys it, while storing the carried cost.
 */
function carried(builder: TransactionBuilder): Transaction {
  const credit = builder.imported().build();
  return { ...credit, naturalKey: naturalKeyFor({ ...credit, unitPrice: Money.zero() }) };
}

/** An import-written leg of any other kind (a debit, a conversion leg). */
function imported(builder: TransactionBuilder): Transaction {
  return builder.imported().build();
}

const subscription = (at: string, on = '2026-02-10') =>
  aTransaction()
    .subscription()
    .at(at)
    .on(on)
    .quantity('20')
    .price('114.90')
    .costEstimate(on)
    .imported()
    .build();

const buy100 = (at: string) =>
  aTransaction().buy().at(at).on('2026-01-05').quantity('100').price('10').build();

function transferPair(from: string, to: string, on: string, quantity: string, price: string) {
  return [
    imported(aTransaction().transferOut().at(from).on(on).quantity(quantity).price('0')),
    carried(aTransaction().transferIn().at(to).on(on).quantity(quantity).price(price)),
  ] as const;
}

function position(snapshots: readonly PositionSnapshot[], at: string, asset = 'PETR4') {
  return snapshots.find(
    (p) => p.assetId === assetIdFor(asset) && p.institutionId === institutionIdFor(at),
  );
}

/** DM-4 / TS-08: the cache equals a rebuild, marker included. */
async function expectRebuildEqualsIncremental(state: ReturnType<typeof deps>) {
  const rebuilt = replayPositions(await state.transactions.listAll());
  if (!rebuilt.ok) throw new Error('ledger does not replay');
  const print = (snapshots: readonly PositionSnapshot[]) =>
    [...snapshots]
      .sort((a, b) => (positionKeyString(a) < positionKeyString(b) ? -1 : 1))
      .map((s) => ({
        key: positionKeyString(s),
        ...serializePosition(s.state),
        costEstimated: s.costEstimated,
      }));
  expect(print(await state.positions.list())).toEqual(print(rebuilt.value));
}

beforeEach(() => {
  resetTransactionSequence();
});

describe('#144 F6 — an edit re-derives what its position carried on', () => {
  it('estimated subscription at A, all of it transferred to B: correcting the price clears B', async () => {
    //  A  2026-01-05  buy 100 @ 10,00                         1.000,00
    //  A  2026-02-10  subscription 20 @ 114,90, estimated     2.298,00
    //  A  2026-03-10  transfer out 120 → B
    //  B  2026-03-10  transfer in 120, carried 3.298,00 ÷ 120 = 27,48333333, estimated
    //
    //  Corrected to 112,95: A before the debit holds 1.000,00 + 20 × 112,95
    //  = 3.259,00 over 120 = 27,158333… → 27,15833333, exact.
    //  B: 120 × 27,15833333 = 3.258,9999996.
    const sub = subscription('A');
    const [debit, credit] = transferPair('A', 'B', '2026-03-10', '120', '27.48333333');
    const state = await seeded([buy100('A'), sub, debit, { ...credit, costIsEstimate: true }]);
    expect(position(await state.positions.list(), 'B')?.costEstimated).toBe(true);

    const result = await editTransaction(state, sub.id, { unitPrice: Money.fromString('112.95') });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rederived.map((t) => t.id)).toEqual([credit.id]);
    const stored = await state.transactions.findById(credit.id);
    expect(stored?.unitPrice.toString()).toBe('27.15833333');
    expect(stored).toMatchObject({
      costIsEstimate: false,
      estimateCloseDate: null,
      // Import's figure, re-read — not a user's statement (BR-006-16).
      isUserModified: false,
      naturalKey: credit.naturalKey,
    });
    const b = position(await state.positions.list(), 'B');
    expect(b?.state.totalCost.toString()).toBe('3258.9999996');
    expect(b?.costEstimated).toBe(false);
    await expectRebuildEqualsIncremental(state);
  });

  it('the same through an X→A→B chain', async () => {
    //  X  2026-02-10  subscription 20 @ 114,90, estimated
    //  X→A 2026-03-01 transfer 20: A's credit carries 114,90, estimated
    //  A  2026-01-05  buy 100 @ 10,00
    //  A→B 2026-03-10 transfer 120: (1.000,00 + 2.298,00) ÷ 120 = 27,48333333, estimated
    //
    //  Corrected to 112,95: X→A carries 112,95, exact; A before its debit holds
    //  1.000,00 + 2.259,00 = 3.259,00 over 120 → 27,15833333, exact.
    const sub = subscription('X');
    const [xDebit, xCredit] = transferPair('X', 'A', '2026-03-01', '20', '114.9');
    const [aDebit, aCredit] = transferPair('A', 'B', '2026-03-10', '120', '27.48333333');
    const state = await seeded([
      sub,
      xDebit,
      { ...xCredit, costIsEstimate: true },
      buy100('A'),
      aDebit,
      { ...aCredit, costIsEstimate: true },
    ]);

    const result = await editTransaction(state, sub.id, { unitPrice: Money.fromString('112.95') });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rederived.map((t) => t.id).sort()).toEqual([xCredit.id, aCredit.id].sort());
    const toA = await state.transactions.findById(xCredit.id);
    const toB = await state.transactions.findById(aCredit.id);
    expect(toA?.unitPrice.toString()).toBe('112.95');
    expect(toA?.costIsEstimate).toBe(false);
    expect(toB?.unitPrice.toString()).toBe('27.15833333');
    expect(toB?.costIsEstimate).toBe(false);
    expect(position(await state.positions.list(), 'B')?.costEstimated).toBe(false);
    await expectRebuildEqualsIncremental(state);
  });

  it('a mixed lot, part of it transferred: correcting the estimated row clears B', async () => {
    //  A: buy 100 @ 10,00 + subscription 20 @ 114,90 (estimated) = 120, 3.298,00
    //  A→B 2026-03-10: 60 of the 120, carried 27,48333333, estimated
    //  Corrected to 112,95: 3.259,00 ÷ 120 = 27,15833333, exact.
    //  B: 60 × 27,15833333 = 1.629,4999998. A keeps 60, now exact too.
    const sub = subscription('A');
    const [debit, credit] = transferPair('A', 'B', '2026-03-10', '60', '27.48333333');
    const state = await seeded([buy100('A'), sub, debit, { ...credit, costIsEstimate: true }]);

    const result = await editTransaction(state, sub.id, { unitPrice: Money.fromString('112.95') });

    expect(result.ok).toBe(true);
    const positions = await state.positions.list();
    expect(position(positions, 'B')?.state.totalCost.toString()).toBe('1629.4999998');
    expect(position(positions, 'B')?.costEstimated).toBe(false);
    expect(position(positions, 'A')?.state.quantity.toString()).toBe('60');
    expect(position(positions, 'A')?.costEstimated).toBe(false);
    await expectRebuildEqualsIncremental(state);
  });

  it('an edit that changes only the fees clears nothing, and still re-carries the cost', async () => {
    //  Fees 1,00 on the subscription: A before the debit holds
    //  1.000,00 + 2.298,00 + 1,00 = 3.299,00 over 120 = 27,491666… → 27,49166667.
    //  The price is still the 114,90 estimate, so every mark stays (D12).
    const sub = subscription('A');
    const [debit, credit] = transferPair('A', 'B', '2026-03-10', '120', '27.48333333');
    const state = await seeded([buy100('A'), sub, debit, { ...credit, costIsEstimate: true }]);

    const result = await editTransaction(state, sub.id, {
      unitPrice: Money.fromString('114.90'),
      fees: Money.fromString('1.00'),
    });

    expect(result.ok && result.value.transaction.costIsEstimate).toBe(true);
    const stored = await state.transactions.findById(credit.id);
    expect(stored?.unitPrice.toString()).toBe('27.49166667');
    expect(stored?.costIsEstimate).toBe(true);
    expect(position(await state.positions.list(), 'B')?.costEstimated).toBe(true);
    await expectRebuildEqualsIncremental(state);
  });

  it('an edit that moves nothing downstream writes nothing downstream', async () => {
    // A date-only edit of the subscription, still before the transfer: the
    // average A carries is unchanged, so the credit is not rewritten.
    const sub = subscription('A');
    const [debit, credit] = transferPair('A', 'B', '2026-03-10', '120', '27.48333333');
    const state = await seeded([buy100('A'), sub, debit, { ...credit, costIsEstimate: true }]);

    const result = await editTransaction(state, sub.id, {
      tradeDate: '2026-02-11' as Transaction['tradeDate'],
    });

    expect(result.ok && result.value.rederived).toEqual([]);
    expect((await state.transactions.findById(credit.id))?.updatedAt).toEqual(credit.updatedAt);
  });

  it('leaves a carried credit the user edited as the user left it (BR-006-16)', async () => {
    const sub = subscription('A');
    const [debit, credit] = transferPair('A', 'B', '2026-03-10', '120', '27.48333333');
    const userOwned = { ...credit, costIsEstimate: true, isUserModified: true };
    const state = await seeded([buy100('A'), sub, debit, userOwned]);

    const result = await editTransaction(state, sub.id, { unitPrice: Money.fromString('112.95') });

    expect(result.ok && result.value.rederived).toEqual([]);
    const stored = await state.transactions.findById(credit.id);
    expect(stored?.unitPrice.toString()).toBe('27.48333333');
    // Still marked: its cost still came from the estimate. Errs toward
    // "estimated", never toward a false "exact".
    expect(stored?.costIsEstimate).toBe(true);
  });

  it('leaves a priced credit alone — its cost is B3’s, not carried', async () => {
    const sub = subscription('A');
    const [debit, credit] = transferPair('A', 'B', '2026-03-10', '120', '30');
    const priced = { ...credit, naturalKey: naturalKeyFor(credit) };
    const state = await seeded([buy100('A'), sub, debit, priced]);

    const result = await editTransaction(state, sub.id, { unitPrice: Money.fromString('112.95') });

    expect(result.ok && result.value.rederived).toEqual([]);
  });

  it('an import in-place edit does not re-derive — the commit carried already', async () => {
    const sub = subscription('A');
    const [debit, credit] = transferPair('A', 'B', '2026-03-10', '120', '27.48333333');
    const state = await seeded([buy100('A'), sub, debit, { ...credit, costIsEstimate: true }]);

    const result = await editTransactions(
      state,
      [{ id: sub.id, input: { unitPrice: Money.fromString('112.95') } }],
      { rederiveCarriedLegs: false },
    );

    expect(result.ok && result.value.rederived).toEqual([]);
    expect((await state.transactions.findById(credit.id))?.costIsEstimate).toBe(true);
  });
});

describe('#144 F6 — an import-resolved conversion is re-derived with its source', () => {
  const group = '00000000-c0de-7000-8000-000000000044';

  /**
   * OLD3: buy 100 @ 10,00 + estimated subscription 20 @ 114,90 = 120, 3.298,00.
   * 2026-03-01: all 120 converted into 60 NEW3 at 3.298,00, estimated.
   */
  function ledger(conversionOut = '120', costOut = '3298', incoming = [['60', '3298']]) {
    const sub = { ...subscription('A'), assetId: assetIdFor('OLD3') };
    return {
      sub,
      rows: [
        aTransaction()
          .buy()
          .of('OLD3')
          .at('A')
          .on('2026-01-05')
          .quantity('100')
          .price('10')
          .build(),
        sub,
        imported(
          aTransaction()
            .conversionOut(group, costOut)
            .of('OLD3')
            .at('A')
            .on('2026-03-01')
            .quantity(conversionOut),
        ),
        ...incoming.map(([quantity, cost], index) => ({
          ...imported(
            aTransaction()
              .conversionIn(cost as string, group)
              .of(index === 0 ? 'NEW3' : 'NEW4')
              .at('A')
              .on('2026-03-01')
              .quantity(quantity as string),
          ),
          costIsEstimate: true,
        })),
      ],
    };
  }

  it('correcting the source price clears the target and moves its cost', async () => {
    //  Corrected to 112,95: OLD3 holds 1.000,00 + 2.259,00 = 3.259,00 when all
    //  120 leave — out 3.259,00, in 3.259,00, exact. NEW3: 60 at 54,316666…
    const { sub, rows } = ledger();
    const state = await seeded(rows);
    expect(position(await state.positions.list(), 'A', 'NEW3')?.costEstimated).toBe(true);

    const result = await editTransaction(state, sub.id, { unitPrice: Money.fromString('112.95') });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const legs = await state.transactions.listByConversionGroup(
      rows[2]?.conversionGroupId as never,
    );
    const out = legs.find((leg) => leg.type === 'conversion_out');
    const into = legs.find((leg) => leg.type === 'conversion_in');
    expect(out?.costBasis?.toString()).toBe('3259');
    expect(into?.costBasis?.toString()).toBe('3259');
    expect(into).toMatchObject({ costIsEstimate: false, estimateCloseDate: null });
    const target = position(await state.positions.list(), 'A', 'NEW3');
    expect(target?.state.totalCost.toString()).toBe('3259');
    expect(asStored(target?.state.averageCost as Money)).toBe('54.31666667');
    expect(target?.costEstimated).toBe(false);
    await expectRebuildEqualsIncremental(state);
  });

  it('without the re-derivation the correction could not even be applied', async () => {
    // The stored outgoing leg removes 3.298,00 from a position now holding
    // 3.259,00 — 39,00 more than there is, which BR-006-15 refuses.
    const { sub, rows } = ledger();
    const state = await seeded(rows);
    const result = await editTransactions(
      state,
      [{ id: sub.id, input: { unitPrice: Money.fromString('112.95') } }],
      { rederiveCarriedLegs: false },
    );
    expect(result.ok).toBe(false);
  });

  it('a partial conversion removes the proportional cost and shares it as stored', async () => {
    //  60 of 120 leave: out = 3.298,00 × 60 ÷ 120 = 1.649,00, split into
    //  NEW3 1.000,00 and NEW4 649,00 at import.
    //  Corrected to 112,95: out = 3.259,00 × 60 ÷ 120 = 1.629,50;
    //    NEW3 = 1.629,50 × 1.000 ÷ 1.649 = 988,17465130… → 988,17465130
    //    NEW4 = the residual, 1.629,50 − 988,17465130 = 641,32534870
    const { sub, rows } = ledger('60', '1649', [
      ['30', '1000'],
      ['30', '649'],
    ]);
    const state = await seeded(rows);

    const result = await editTransaction(state, sub.id, { unitPrice: Money.fromString('112.95') });

    expect(result.ok).toBe(true);
    const legs = (await state.transactions.listAll()).filter((t) => t.conversionGroupId !== null);
    expect(legs.find((t) => t.type === 'conversion_out')?.costBasis?.toString()).toBe('1629.5');
    const ins = legs.filter((t) => t.type === 'conversion_in');
    expect(ins.map((t) => t.costBasis?.toString())).toEqual(['988.1746513', '641.3253487']);
    expect(ins.every((t) => !t.costIsEstimate)).toBe(true);
    // A keeps the other 60, now exact: 3.259,00 − 1.629,50 = 1.629,50.
    const a = position(await state.positions.list(), 'A', 'OLD3');
    expect(a?.state.totalCost.toString()).toBe('1629.5');
    expect(a?.costEstimated).toBe(false);
    await expectRebuildEqualsIncremental(state);
  });

  describe('#144 re-review N1 — deleting the source row of a partial import conversion', () => {
    //  OLD3 at A: buy 100 @ 10,00 + estimated subscription 20 @ 114,90
    //  = 120, 3.298,00. 2026-03-01: 60 leave, 3.298,00 × 60 ÷ 120 = 1.649,00,
    //  into 30 NEW3, estimated.
    //
    //  Without the subscription A holds 100 @ 10,00 = 1.000,00 when the 60
    //  leave. The stored leg would remove 1.649,00 of 1.000,00 — refused as
    //  insufficient — but re-derived it removes 1.000,00 × 60 ÷ 100 = 600,00:
    //    OLD3: 40, 400,00, 10,00, exact;  NEW3: 30, 600,00, 20,00, exact.
    const partial = () => ledger('60', '1649', [['30', '1649']]);

    async function expectResolved(state: ReturnType<typeof deps>) {
      const legs = (await state.transactions.listAll()).filter((t) => t.conversionGroupId !== null);
      expect(legs.find((t) => t.type === 'conversion_out')?.costBasis?.toString()).toBe('600');
      const into = legs.find((t) => t.type === 'conversion_in');
      expect(into?.costBasis?.toString()).toBe('600');
      expect(into?.costIsEstimate).toBe(false);
      const positions = await state.positions.list();
      const old3 = position(positions, 'A', 'OLD3');
      expect(old3?.state.quantity.toString()).toBe('40');
      expect(old3?.state.totalCost.toString()).toBe('400');
      expect(old3?.state.averageCost.toString()).toBe('10');
      expect(old3?.costEstimated).toBe(false);
      const new3 = position(positions, 'A', 'NEW3');
      expect(new3?.state.totalCost.toString()).toBe('600');
      expect(new3?.state.averageCost.toString()).toBe('20');
      expect(new3?.costEstimated).toBe(false);
      await expectRebuildEqualsIncremental(state);
    }

    it('deleteTransaction guards the source with its re-derived leg in place', async () => {
      const { sub, rows } = partial();
      const state = await seeded(rows);

      const result = await deleteTransaction(state, sub.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.rederived).toHaveLength(2);
      await expectResolved(state);
    });

    it('bulkDeleteTransactions does the same', async () => {
      const { sub, rows } = partial();
      const state = await seeded(rows);

      const result = await bulkDeleteTransactions(state, [sub.id]);

      expect(result.ok).toBe(true);
      await expectResolved(state);
    });
  });

  it('leaves a manual conversion group to the user', async () => {
    // A manual group's allocation is the user's; its marker is recomputed
    // when they edit the group. Raising the price keeps the ledger replayable.
    const { sub, rows } = ledger();
    const manual = rows.map((t) => (t.conversionGroupId === null ? t : { ...t, isManual: true }));
    const state = await seeded(manual);

    const result = await editTransaction(state, sub.id, { unitPrice: Money.fromString('115') });

    expect(result.ok && result.value.rederived).toEqual([]);
  });
});

describe('#144 F6 — a delete re-derives what its position carried on', () => {
  //  A: buy 100 @ 10,00 + estimated subscription 20 @ 114,90; 100 of the 120
  //  sent to B at 27,48333333, estimated. Deleting the subscription leaves A
  //  holding 100 @ 10,00 before the debit: B's credit carries 10,00, exact.
  function ledger() {
    const sub = subscription('A');
    const [debit, credit] = transferPair('A', 'B', '2026-03-10', '100', '27.48333333');
    return { sub, credit, rows: [buy100('A'), sub, debit, { ...credit, costIsEstimate: true }] };
  }

  it('deleting the estimated row clears the credit it fed', async () => {
    const { sub, credit, rows } = ledger();
    const state = await seeded(rows);

    const result = await deleteTransaction(state, sub.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rederived.map((t) => t.id)).toEqual([credit.id]);
    expect(result.value.downstream).toHaveLength(1);
    const stored = await state.transactions.findById(credit.id);
    expect(stored?.unitPrice.toString()).toBe('10');
    expect(stored?.costIsEstimate).toBe(false);
    const b = position(await state.positions.list(), 'B');
    expect(b?.state.totalCost.toString()).toBe('1000');
    expect(b?.costEstimated).toBe(false);
    await expectRebuildEqualsIncremental(state);
  });

  it('a bulk delete does the same', async () => {
    const { sub, credit, rows } = ledger();
    const state = await seeded(rows);

    const result = await bulkDeleteTransactions(state, [sub.id]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rederived.map((t) => t.id)).toEqual([credit.id]);
    // A, then B.
    expect(result.value.recalculations).toHaveLength(2);
    expect((await state.transactions.findById(credit.id))?.costIsEstimate).toBe(false);
    await expectRebuildEqualsIncremental(state);
  });

  it('a delete that would strand the debit is refused, and nothing downstream moves', async () => {
    // All 120 sent: without the subscription A holds 100 when 120 leave.
    const sub = subscription('A');
    const [debit, credit] = transferPair('A', 'B', '2026-03-10', '120', '27.48333333');
    const state = await seeded([buy100('A'), sub, debit, { ...credit, costIsEstimate: true }]);

    const result = await deleteTransaction(state, sub.id);

    expect(result.ok).toBe(false);
    expect((await state.transactions.findById(credit.id))?.costIsEstimate).toBe(true);
  });
});

describe('#144 F6 — what the downstream re-derivation guards and recalculates', () => {
  it('refuses a delete whose re-carry would strand a manual conversion downstream (BR-006-15)', async () => {
    //  A: buy 100 @ 10,00 + estimated subscription 20 @ 114,90; 100 sent to B
    //  at 27,48333333 (2.748,333333). B converts all 100 by hand, removing
    //  2.748,333333. Deleting the subscription re-carries B's credit at 10,00
    //  — 1.000,00 — and the hand-made leg would remove 1.748,33 more than B
    //  holds. Refused whole: nothing is deleted, nothing re-carried.
    const sub = subscription('A');
    const [debit, credit] = transferPair('A', 'B', '2026-03-10', '100', '27.48333333');
    const group = '00000000-c0de-7000-8000-000000000046';
    const manualOut = aTransaction()
      .conversionOut(group, '2748.333333')
      .at('B')
      .on('2026-04-01')
      .quantity('100')
      .build();
    const manualIn = aTransaction()
      .conversionIn('2748.333333', group)
      .of('NEW3')
      .at('B')
      .on('2026-04-01')
      .quantity('50')
      .build();
    const rows = [
      buy100('A'),
      sub,
      debit,
      { ...credit, costIsEstimate: true },
      manualOut,
      manualIn,
    ];

    const single = await seeded(rows);
    const refused = await deleteTransaction(single, sub.id);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe('INSUFFICIENT_QUANTITY');
    expect(await single.transactions.findById(sub.id)).not.toBeNull();
    expect((await single.transactions.findById(credit.id))?.costIsEstimate).toBe(true);

    const bulk = await seeded(rows);
    expect((await bulkDeleteTransactions(bulk, [sub.id])).ok).toBe(false);
    expect(await bulk.transactions.findById(sub.id)).not.toBeNull();
  });

  it('a same-position round trip is re-carried and recalculated once, with its own position', async () => {
    //  #135's shape: A sends 100 to itself on 2026-03-10. With the estimated
    //  subscription the credit carried 27,48333333; deleted, A holds 100 @
    //  10,00 before the debit, the credit carries 10,00, and A ends at 100
    //  shares, 1.000,00, exact.
    const sub = subscription('A');
    const [debit, credit] = transferPair('A', 'A', '2026-03-10', '100', '27.48333333');
    const state = await seeded([buy100('A'), sub, debit, { ...credit, costIsEstimate: true }]);

    const result = await deleteTransaction(state, sub.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rederived.map((t) => t.id)).toEqual([credit.id]);
    // A is the deleted row's own position: recalculated there, not twice.
    expect(result.value.downstream).toEqual([]);
    const a = position(await state.positions.list(), 'A');
    expect(a?.state.totalCost.toString()).toBe('1000');
    expect(a?.costEstimated).toBe(false);
    await expectRebuildEqualsIncremental(state);
  });

  it('recalculates a position two re-derived legs land in once, from the earlier leg', async () => {
    //  X and Y each hold 100 @ 10,00 plus an estimated 20 @ 114,90 and send
    //  60 to B — Y on 2026-03-01, X on 2026-03-10 (X's credit stored first).
    //  Each carries 3.298,00 ÷ 120 = 27,48333333. Deleting both subscriptions:
    //  each carries 10,00, B holds 120 at 1.200,00, exact.
    const subX = subscription('X');
    const subY = subscription('Y');
    const [xDebit, xCredit] = transferPair('X', 'B', '2026-03-10', '60', '27.48333333');
    const [yDebit, yCredit] = transferPair('Y', 'B', '2026-03-01', '60', '27.48333333');
    const state = await seeded([
      buy100('X'),
      buy100('Y'),
      subX,
      subY,
      xDebit,
      yDebit,
      { ...xCredit, costIsEstimate: true },
      { ...yCredit, costIsEstimate: true },
    ]);

    const result = await bulkDeleteTransactions(state, [subX.id, subY.id]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // X, Y, then B — once, from 2026-03-01.
    expect(result.value.recalculations.map((r) => r.scope.fromDate)).toEqual([
      '2026-02-10',
      '2026-02-10',
      '2026-03-01',
    ]);
    const b = position(await state.positions.list(), 'B');
    expect(b?.state.totalCost.toString()).toBe('1200');
    expect(b?.costEstimated).toBe(false);
    await expectRebuildEqualsIncremental(state);
  });
});

/**
 * SPEC-006 BR-006-13 (#144 re-review N3): the confirmation states what will be
 * recalculated — now including the positions downstream a delete re-derives,
 * read from the same plan the delete executes.
 */
describe('#144 N3 — describeDeletionImpact names the downstream positions', () => {
  it('states B before and after when deleting the estimated row A carried on', async () => {
    //  A: buy 100 @ 10,00 + estimated subscription 20 @ 114,90 = 120, 3.298,00.
    //  100 sent to B at 27,48333333 → B: 100, 2.748,333333, estimated.
    //  Without the subscription A carries 10,00 → B: 100, 1.000,00, 10,00, exact.
    //  A itself: 120 − 100 = 20 today; 100 − 100 = 0 after.
    const sub = subscription('A');
    const [debit, credit] = transferPair('A', 'B', '2026-03-10', '100', '27.48333333');
    const state = await seeded([buy100('A'), sub, debit, { ...credit, costIsEstimate: true }]);

    const impact = await describeDeletionImpact(state, sub.id);

    expect(impact.ok).toBe(true);
    if (!impact.ok) return;
    expect(impact.value.currentPosition.quantity.toString()).toBe('20');
    expect(impact.value.projectedPosition.quantity.toString()).toBe('0');
    expect(impact.value.downstream).toHaveLength(1);
    const [b] = impact.value.downstream;
    expect(b?.assetId).toBe(assetIdFor('PETR4'));
    expect(b?.institutionId).toBe(institutionIdFor('B'));
    expect(b?.currentPosition.quantity.toString()).toBe('100');
    expect(b?.currentPosition.totalCost.toString()).toBe('2748.333333');
    expect(b?.currentPosition.averageCost.toString()).toBe('27.48333333');
    expect(b?.currentCostEstimated).toBe(true);
    expect(b?.projectedPosition.quantity.toString()).toBe('100');
    expect(b?.projectedPosition.totalCost.toString()).toBe('1000');
    expect(b?.projectedPosition.averageCost.toString()).toBe('10');
    expect(b?.projectedCostEstimated).toBe(false);

    // What it states is what the delete then does.
    expect((await deleteTransaction(state, sub.id)).ok).toBe(true);
    const after = position(await state.positions.list(), 'B');
    expect(after?.state.totalCost.toString()).toBe(b?.projectedPosition.totalCost.toString());
    expect(after?.costEstimated).toBe(b?.projectedCostEstimated);
  });

  it('names no downstream position when the row’s position sent nothing on', async () => {
    const sub = subscription('A');
    const state = await seeded([buy100('A'), sub]);

    const impact = await describeDeletionImpact(state, sub.id);

    expect(impact.ok && impact.value.downstream).toEqual([]);
  });

  it('projects a partial import conversion at the row’s own position, and its target', async () => {
    //  The N1 shape: OLD3 100 @ 10,00 + estimated 20 @ 114,90; 60 converted
    //  at 1.649,00 into 30 NEW3. Without the subscription the leg removes
    //  1.000,00 × 60 ÷ 100 = 600,00: OLD3 40, 400,00; NEW3 30, 600,00, 20,00.
    const group = '00000000-c0de-7000-8000-000000000047';
    const sub = { ...subscription('A'), assetId: assetIdFor('OLD3') };
    const state = await seeded([
      aTransaction().buy().of('OLD3').at('A').on('2026-01-05').quantity('100').price('10').build(),
      sub,
      imported(
        aTransaction()
          .conversionOut(group, '1649')
          .of('OLD3')
          .at('A')
          .on('2026-03-01')
          .quantity('60'),
      ),
      {
        ...imported(
          aTransaction()
            .conversionIn('1649', group)
            .of('NEW3')
            .at('A')
            .on('2026-03-01')
            .quantity('30'),
        ),
        costIsEstimate: true,
      },
    ]);

    const impact = await describeDeletionImpact(state, sub.id);

    expect(impact.ok).toBe(true);
    if (!impact.ok) return;
    expect(impact.value.projectedPosition.quantity.toString()).toBe('40');
    expect(impact.value.projectedPosition.totalCost.toString()).toBe('400');
    expect(impact.value.projectedCostEstimated).toBe(false);
    const [new3] = impact.value.downstream;
    expect(new3?.assetId).toBe(assetIdFor('NEW3'));
    expect(new3?.currentPosition.totalCost.toString()).toBe('1649');
    expect(new3?.currentCostEstimated).toBe(true);
    expect(new3?.projectedPosition.totalCost.toString()).toBe('600');
    expect(new3?.projectedPosition.averageCost.toString()).toBe('20');
    expect(new3?.projectedCostEstimated).toBe(false);
  });

  it('reports the refusal when a downstream position would not replay', async () => {
    // B converts its 100 by hand at 2.748,333333; re-carried at 10,00 B would
    // hold 1.000,00 — the delete is refused, and the preview says so first.
    const sub = subscription('A');
    const [debit, credit] = transferPair('A', 'B', '2026-03-10', '100', '27.48333333');
    const group = '00000000-c0de-7000-8000-000000000048';
    const state = await seeded([
      buy100('A'),
      sub,
      debit,
      { ...credit, costIsEstimate: true },
      aTransaction()
        .conversionOut(group, '2748.333333')
        .at('B')
        .on('2026-04-01')
        .quantity('100')
        .build(),
      aTransaction()
        .conversionIn('2748.333333', group)
        .of('NEW3')
        .at('B')
        .on('2026-04-01')
        .quantity('50')
        .build(),
    ]);

    const impact = await describeDeletionImpact(state, sub.id);

    expect(impact.ok).toBe(false);
    if (impact.ok) return;
    expect(impact.error.code).toBe('INSUFFICIENT_QUANTITY');
  });
});

describe('rederiveCarriedLegs — the pure planner', () => {
  const key = (at: string, asset = 'PETR4') => ({
    assetId: assetIdFor(asset),
    institutionId: institutionIdFor(at),
  });

  it('touches nothing when no seed sends anything on', () => {
    const [debit, credit] = transferPair('A', 'B', '2026-03-10', '100', '99');
    const rows = [buy100('A'), debit, credit, buy100('C')];
    expect(rederiveCarriedLegs(rows, [key('C')], NOW, NO_AMORTIZATION)).toEqual([]);
  });

  it('keeps an ambiguous pair — two identical debits, one credit — as stored', () => {
    const [debit, credit] = transferPair('A', 'B', '2026-03-10', '50', '99');
    const [otherDebit] = transferPair('C', 'B', '2026-03-10', '50', '0');
    const rows = [buy100('A'), buy100('C'), debit, otherDebit, credit];
    expect(rederiveCarriedLegs(rows, [key('A'), key('C')], NOW, NO_AMORTIZATION)).toEqual([]);
  });

  it('keeps a credit whose source can no longer carry — its stored figure is the fallback', () => {
    // The debit takes 100 from a source that never held them.
    const [debit, credit] = transferPair('A', 'B', '2026-03-10', '100', '12');
    expect(rederiveCarriedLegs([debit, credit], [key('A')], NOW, NO_AMORTIZATION)).toEqual([]);
  });

  it('stamps what it rewrites with the time of the write', () => {
    const [debit, credit] = transferPair('A', 'B', '2026-03-10', '100', '99');
    const [next] = rederiveCarriedLegs(
      [buy100('A'), debit, credit],
      [key('A')],
      NOW,
      NO_AMORTIZATION,
    );
    expect(next?.unitPrice.toString()).toBe('10');
    expect(next?.updatedAt).toEqual(NOW);
  });

  describe('a conversion group it cannot re-derive keeps its stored figures', () => {
    const group = '00000000-c0de-7000-8000-000000000045';
    const out = (quantity: string, cost = '1000') =>
      imported(
        aTransaction()
          .conversionOut(group, cost)
          .of('OLD3')
          .at('A')
          .on('2026-03-01')
          .quantity(quantity),
      );
    const into = (cost: string, asset = 'NEW3') =>
      imported(
        aTransaction().conversionIn(cost, group).of(asset).at('A').on('2026-03-01').quantity('50'),
      );
    const source = () =>
      aTransaction().buy().of('OLD3').at('A').on('2026-01-05').quantity('100').price('10').build();
    const seed = [key('A', 'OLD3')];

    it('when the source held fewer shares than leave', () => {
      expect(
        rederiveCarriedLegs([source(), out('150'), into('1000')], seed, NOW, NO_AMORTIZATION),
      ).toEqual([]);
    });

    it('when the source prefix does not replay', () => {
      const oversold = aTransaction()
        .sell()
        .of('OLD3')
        .at('A')
        .on('2026-02-01')
        .quantity('500')
        .build();
      expect(
        rederiveCarriedLegs(
          [source(), oversold, out('100'), into('1000')],
          seed,
          NOW,
          NO_AMORTIZATION,
        ),
      ).toEqual([]);
    });

    it('when several targets were given no cost to share it by', () => {
      const rows = [source(), out('100', '0'), into('0'), into('0', 'NEW4')];
      expect(rederiveCarriedLegs(rows, seed, NOW, NO_AMORTIZATION)).toEqual([]);
    });

    it('but gives the whole cost to a single target that had none', () => {
      // 100 @ 10,00 = 1.000,00 removed; the one target takes it all.
      const [changedOut, changedIn] = rederiveCarriedLegs(
        [source(), out('100', '0'), into('0')],
        seed,
        NOW,
        NO_AMORTIZATION,
      );
      expect(changedOut?.costBasis?.toString()).toBe('1000');
      expect(changedIn?.costBasis?.toString()).toBe('1000');
    });

    it('and a zero-share target stays at zero while the residual goes to the last positive one', () => {
      //  Stored shares 0 / 600 / 400 of 1.000,00; the source is now 1.200,00
      //  (100 @ 12,00): 0, 1.200 × 600 ÷ 1.000 = 720,00, residual 480,00.
      const dearer = aTransaction()
        .buy()
        .of('OLD3')
        .at('A')
        .on('2026-01-05')
        .quantity('100')
        .price('12')
        .build();
      const rows = [dearer, out('100'), into('0'), into('600', 'NEW4'), into('400', 'NEW5')];
      const changed = rederiveCarriedLegs(rows, seed, NOW, NO_AMORTIZATION);
      const byAsset = (asset: string) =>
        changed.find((t) => t.assetId === assetIdFor(asset))?.costBasis?.toString();
      expect(byAsset('OLD3')).toBe('1200');
      expect(byAsset('NEW3')).toBeUndefined();
      expect(byAsset('NEW4')).toBe('720');
      expect(byAsset('NEW5')).toBe('480');
    });
  });
});

describe('positionsOf', () => {
  it('one entry per position, dated its earliest leg whatever the order', () => {
    const early = aTransaction().transferIn().at('B').on('2026-03-01').build();
    const late = aTransaction().transferIn().at('B').on('2026-03-10').build();
    const elsewhere = aTransaction().transferIn().at('C').on('2026-03-05').build();
    expect(positionsOf([early, late, elsewhere]).map((p) => p.fromDate)).toEqual([
      '2026-03-01',
      '2026-03-05',
    ]);
    expect(positionsOf([late, early]).map((p) => p.fromDate)).toEqual(['2026-03-01']);
  });
});

describe('planCarriedLegUpdates — the whole-ledger read only when it can matter', () => {
  it('returns nothing, without reading the ledger, for a position that sends nothing on', async () => {
    const state = await seeded([buy100('A')]);
    let reads = 0;
    const listAll = state.transactions.listAll.bind(state.transactions);
    state.transactions.listAll = async () => {
      reads += 1;
      return listAll();
    };
    const planned = await planCarriedLegUpdates(
      state,
      [{ assetId: assetIdFor('PETR4'), institutionId: institutionIdFor('A') }],
      (ledger) => ledger,
    );
    expect(planned).toEqual([]);
    expect(reads).toBe(0);
  });
});
