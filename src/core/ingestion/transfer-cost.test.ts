import { beforeEach, describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import {
  AssetId,
  type AssetId as AssetIdType,
  ImportBatchId,
  ImportRowId,
  InstitutionId,
  type InstitutionId as InstitutionIdType,
} from '@/core/shared/ids';
import { asStored, Money, Quantity } from '@/core/shared/money';
import type { Transaction } from '@/core/ledger/transaction';
import {
  aTransaction,
  resetTransactionSequence,
} from '@/core/ledger/test-support/transaction-builder';
import type { ImportRow, NormalizedTransactionRecord } from '@/core/ingestion/ports';
import {
  type CarryLeg,
  debitsHeldBack,
  isCarryCandidate,
  pairTransfers,
  resolveCarriedCosts,
  type TransferLeg,
  withCarriedCost,
} from '@/core/ingestion/transfer-cost';

const money = (value: string) => Money.fromString(value);

describe('#110 BR-005-20a — isCarryCandidate', () => {
  const record: NormalizedTransactionRecord = {
    kind: 'transaction',
    b3Type: 'Transferência',
    direction: 'credit',
    assetCode: 'PETR4',
    assetName: 'Petrobras PN',
    assetClass: 'stock',
    institutionName: 'Destino',
    tradeDate: BusinessDate.of('2026-03-10'),
    quantity: Quantity.fromString('100'),
    unitPrice: Money.zero(),
    priceStated: false,
    fees: Money.zero(),
    ratio: null,
  };
  const row = (overrides: Partial<ImportRow>): ImportRow => ({
    id: ImportRowId.generate(),
    batchId: ImportBatchId.generate(),
    raw: {},
    record,
    assetId: AssetId.generate(),
    institutionId: null,
    classification: 'unclassified',
    naturalKey: 'k',
    occurrence: 1,
    ledgerType: 'transfer_in',
    transactionId: null,
    ...overrides,
  });

  it('is a transfer in whose extract gave no price', () => {
    expect(isCarryCandidate(row({}))).toBe(true);
  });

  it('is not a priced transfer, another type, or a position row', () => {
    expect(isCarryCandidate(row({ record: { ...record, priceStated: true } }))).toBe(false);
    expect(isCarryCandidate(row({ ledgerType: 'transfer_out' }))).toBe(false);
    expect(
      isCarryCandidate(
        row({
          record: {
            kind: 'position',
            assetCode: 'PETR4',
            assetName: 'Petrobras PN',
            assetClass: 'stock',
            institutionName: null,
            quantity: Quantity.fromString('100'),
            fixedIncome: null,
          },
        }),
      ),
    ).toBe(false);
  });
});

describe('#110 BR-005-20a — pairTransfers', () => {
  const asset = AssetId.generate();
  const destination = InstitutionId.generate();
  const source = InstitutionId.generate();
  const third = InstitutionId.generate();

  function leg(id: string, overrides: Partial<TransferLeg> = {}): TransferLeg {
    return {
      id,
      assetId: asset,
      institutionId: destination,
      tradeDate: BusinessDate.of('2026-03-10'),
      quantity: Quantity.fromString('100'),
      ...overrides,
    };
  }

  it('pairs a credit with the one debit of the same asset, date and quantity at another institution', () => {
    const pairs = pairTransfers([leg('in')], [leg('out', { institutionId: source })]);
    expect([...pairs]).toEqual([['in', 'out']]);
  });

  it('pairs a credit with no institution to a debit at a known one', () => {
    const pairs = pairTransfers(
      [leg('in', { institutionId: null })],
      [leg('out', { institutionId: source })],
    );
    expect([...pairs]).toEqual([['in', 'out']]);
  });

  it('pairs nothing with two candidate debits, in either file order', () => {
    const a = leg('from-source', { institutionId: source });
    const c = leg('from-third', { institutionId: third });
    expect(pairTransfers([leg('in')], [a, c]).size).toBe(0);
    expect(pairTransfers([leg('in')], [c, a]).size).toBe(0);
  });

  it('pairs nothing when two credits compete for one debit', () => {
    const pairs = pairTransfers(
      [leg('in-1'), leg('in-2', { institutionId: third })],
      [leg('out', { institutionId: source })],
    );
    expect(pairs.size).toBe(0);
  });

  /**
   * #135 — B3 recorded the ENBR3 buyout as a price-less debit *and* credit at
   * one broker. Requiring a different institution formed no pair, so the
   * credit stayed unclassified while the debit applied and the position went
   * to zero.
   */
  it('pairs a credit with a debit at its own institution', () => {
    const pairs = pairTransfers([leg('in')], [leg('out')]);
    expect([...pairs]).toEqual([['in', 'out']]);
  });

  it('#135: a same-institution debit competes, so a credit seeing both pairs with neither', () => {
    expect(
      pairTransfers([leg('in')], [leg('own'), leg('out', { institutionId: source })]).size,
    ).toBe(0);
  });

  it.each<[string, Partial<TransferLeg>]>([
    ['has no institution', { institutionId: null }],
    ['is of another asset', { institutionId: source, assetId: AssetId.generate() as AssetIdType }],
    ['is on another day', { institutionId: source, tradeDate: BusinessDate.of('2026-03-11') }],
    ['moves another quantity', { institutionId: source, quantity: Quantity.fromString('99') }],
  ])('does not match a debit that %s', (_label, overrides) => {
    expect(pairTransfers([leg('in')], [leg('out', overrides)]).size).toBe(0);
  });
});

describe('#110 BR-005-20a — resolveCarriedCosts', () => {
  beforeEach(() => resetTransactionSequence());

  /** A ledger keyed by position, as `commit-batch.ts` hands it in. */
  function historyOf(rows: readonly Transaction[]) {
    return (assetId: AssetIdType, institutionId: InstitutionIdType | null) =>
      rows.filter((t) => t.assetId === assetId && t.institutionId === institutionId);
  }

  function transfer(id: string, from: string, to: string, on: string, quantity = '100'): CarryLeg {
    return {
      id,
      credit: aTransaction().transferIn().at(to).on(on).quantity(quantity).price('0').build(),
      debit: aTransaction().transferOut().at(from).on(on).quantity(quantity).price('0').build(),
      fallback: null,
    };
  }

  it('carries the source average: 100 @ 10,00 + 100 @ 20,00 → 3.000,00 ÷ 200 = 15,00', () => {
    const history = [
      aTransaction().buy().at('A').on('2026-01-05').quantity('100').price('10').build(),
      aTransaction().buy().at('A').on('2026-02-05').quantity('100').price('20').build(),
    ];
    const costs = resolveCarriedCosts([transfer('t', 'A', 'B', '2026-03-10')], historyOf(history));
    expect(costs.get('t')?.toString()).toBe('15');
  });

  it('defect 1: a bonificação before the transfer counts — 1.000,00 ÷ (100 + 100) = 5,00', () => {
    const history = [
      aTransaction().buy().at('A').on('2026-01-05').quantity('100').price('10').build(),
      // BR-007-05: zero attributed value — quantity up, total cost unchanged.
      aTransaction().bonificacao().at('A').on('2026-02-01').quantity('100').build(),
    ];
    const costs = resolveCarriedCosts([transfer('t', 'A', 'B', '2026-03-10')], historyOf(history));
    expect(costs.get('t')?.toString()).toBe('5');
  });

  it('defect 6: a same-day buy at the source counts, a next-day one does not — (1.000,00 + 2.000,00) ÷ 200 = 15,00', () => {
    const history = [
      aTransaction().buy().at('A').on('2026-01-05').quantity('100').price('10').build(),
      // Rank 1 on the transfer day: applied before the rank-3 debit.
      aTransaction().buy().at('A').on('2026-03-10').quantity('100').price('20').build(),
      aTransaction().buy().at('A').on('2026-03-11').quantity('100').price('90').build(),
    ];
    const leg = transfer('t', 'A', 'B', '2026-03-10');
    // The debit itself sits in the source history, as it does once written.
    const costs = resolveCarriedCosts([leg], historyOf([...history, leg.debit as Transaction]));
    expect(costs.get('t')?.toString()).toBe('15');
  });

  describe('#145 follow-up — a same-position round trip', () => {
    const trip = (id: string, quantity: string) => transfer(id, 'A', 'A', '2026-03-10', quantity);

    it('carries the average from before the trip to every leg, even moving more than half the holding', () => {
      const history = [
        aTransaction().buy().at('A').on('2026-01-05').quantity('800').price('10').build(),
      ];
      const legs = [trip('t1', '455'), trip('t2', '455')];
      const debits = legs.map((leg) => leg.debit as Transaction);
      const costs = resolveCarriedCosts(legs, historyOf([...history, ...debits]));
      expect([costs.get('t1')?.toString(), costs.get('t2')?.toString()]).toEqual(['10', '10']);
    });

    it('carries a repeating average at the column scale', () => {
      const history = [
        aTransaction().buy().at('A').on('2026-01-05').quantity('3').price('3.33333333').build(),
      ];
      const legs = [trip('t1', '2'), trip('t2', '2')];
      const debits = legs.map((leg) => leg.debit as Transaction);
      const costs = resolveCarriedCosts(legs, historyOf([...history, ...debits]));
      expect(costs.get('t1')?.toString()).toBe('3.33333333');
      expect(costs.get('t2')?.toString()).toBe('3.33333333');
    });

    it('carries nothing to any leg once one leg loses its debit', () => {
      const history = [
        aTransaction().buy().at('A').on('2026-01-05').quantity('800').price('10').build(),
      ];
      const kept = trip('t1', '455');
      const broken = { ...trip('t2', '455'), debit: null };
      const costs = resolveCarriedCosts(
        [kept, broken],
        historyOf([...history, kept.debit as Transaction]),
      );
      expect(costs.size).toBe(0);
    });
  });

  it('carries nothing when the debit will not be in the ledger', () => {
    const history = [aTransaction().buy().at('A').on('2026-01-05').price('10').build()];
    const leg = { ...transfer('t', 'A', 'B', '2026-03-10'), debit: null };
    expect(resolveCarriedCosts([leg], historyOf(history)).size).toBe(0);
  });

  it('carries nothing when the source prefix cannot be replayed', () => {
    const history = [aTransaction().sell().at('A').on('2026-01-05').quantity('10').build()];
    expect(
      resolveCarriedCosts([transfer('t', 'A', 'B', '2026-03-10')], historyOf(history)).size,
    ).toBe(0);
  });

  it('carries nothing when the source held fewer shares than leave: 100 < 150', () => {
    const history = [aTransaction().buy().at('A').on('2026-01-05').quantity('100').build()];
    expect(
      resolveCarriedCosts([transfer('t', 'A', 'B', '2026-03-10', '150')], historyOf(history)).size,
    ).toBe(0);
  });

  it('carries nothing when the source held its shares at no cost', () => {
    const history = [aTransaction().bonificacao().at('A').on('2026-01-05').quantity('100').build()];
    expect(
      resolveCarriedCosts([transfer('t', 'A', 'B', '2026-03-10')], historyOf(history)).size,
    ).toBe(0);
  });

  it('resolves a chain X→A→B source first, whatever order the legs arrive in', () => {
    const history = [
      aTransaction().buy().at('X').on('2026-01-05').quantity('100').price('8').build(),
      aTransaction().buy().at('A').on('2026-01-05').quantity('100').price('12').build(),
    ];
    const xToA = transfer('x-to-a', 'X', 'A', '2026-03-01');
    const aToB = transfer('a-to-b', 'A', 'B', '2026-03-10');

    const costs = resolveCarriedCosts([aToB, xToA], historyOf(history));

    // X→A: X's 100 @ 8,00 → 8,00.
    expect(costs.get('x-to-a')?.toString()).toBe('8');
    // A→B: A holds 100 @ 12,00 (1.200,00) + 100 carried @ 8,00 (800,00)
    //       = 2.000,00 ÷ 200 = 10,00.
    expect(costs.get('a-to-b')?.toString()).toBe('10');
  });

  it('is not blocked by a credit into the source that lands after the debit', () => {
    const history = [
      aTransaction().buy().at('X').on('2026-01-05').quantity('100').price('8').build(),
      aTransaction().buy().at('A').on('2026-01-05').quantity('100').price('12').build(),
    ];
    const aToB = transfer('a-to-b', 'A', 'B', '2026-03-10');
    const laterXToA = transfer('x-to-a', 'X', 'A', '2026-03-20');

    const costs = resolveCarriedCosts([aToB, laterXToA], historyOf(history));

    // Only A's own 100 @ 12,00 precedes the debit.
    expect(costs.get('a-to-b')?.toString()).toBe('12');
    expect(costs.get('x-to-a')?.toString()).toBe('8');
  });

  it('does not let a resolved credit elsewhere reach this source', () => {
    const history = [
      aTransaction().buy().at('A').on('2026-01-05').quantity('100').price('10').build(),
      aTransaction().buy().at('C').on('2026-01-05').quantity('100').price('30').build(),
    ];
    const costs = resolveCarriedCosts(
      [transfer('a-to-b', 'A', 'B', '2026-03-10'), transfer('c-to-d', 'C', 'D', '2026-03-12')],
      historyOf(history),
    );
    expect(costs.get('a-to-b')?.toString()).toBe('10');
    expect(costs.get('c-to-d')?.toString()).toBe('30');
  });

  it('carries nothing around a same-day swap A→B / B→A, each waiting on the other', () => {
    const history = [
      aTransaction().buy().at('A').on('2026-01-05').quantity('100').price('10').build(),
      aTransaction().buy().at('B').on('2026-01-05').quantity('100').price('20').build(),
    ];
    const costs = resolveCarriedCosts(
      [transfer('a-to-b', 'A', 'B', '2026-03-10'), transfer('b-to-a', 'B', 'A', '2026-03-10')],
      historyOf(history),
    );
    expect(costs.size).toBe(0);
  });

  /**
   * #135 — the ENBR3 shape, one broker: B3 debits and credits the same
   * position. The source *is* the destination, so the carry is the position's
   * own average immediately before the debit, and the pair nets to nothing.
   */
  it('#135: a same-institution pair carries the position’s own average — 3.000,00 ÷ 200 = 15,00', () => {
    const history = [
      aTransaction().buy().at('A').on('2026-01-05').quantity('100').price('10').build(),
      aTransaction().buy().at('A').on('2026-02-05').quantity('100').price('20').build(),
    ];
    const leg = transfer('t', 'A', 'A', '2026-03-10', '200');
    const costs = resolveCarriedCosts([leg], historyOf([...history, leg.debit as Transaction]));
    expect(costs.get('t')?.toString()).toBe('15');
  });

  it('#135: a same-institution pair carries nothing when the position has no history to read', () => {
    const leg = transfer('t', 'A', 'A', '2026-03-10', '200');
    expect(resolveCarriedCosts([leg], historyOf([])).size).toBe(0);
  });

  describe('#112 — a credit carried before keeps or recomputes its cost', () => {
    it('recomputes when the source history grew: stored 10,00 becomes (1.000,00 + 2.000,00) ÷ 200 = 15,00', () => {
      const history = [
        aTransaction().buy().at('A').on('2026-01-05').quantity('100').price('10').build(),
        aTransaction().buy().at('A').on('2026-02-01').quantity('100').price('20').build(),
      ];
      const leg = { ...transfer('t', 'A', 'B', '2026-03-10'), fallback: money('10') };
      expect(resolveCarriedCosts([leg], historyOf(history)).get('t')?.toString()).toBe('15');
    });

    it('keeps the stored cost when the debit is no longer in the ledger', () => {
      const leg = { ...transfer('t', 'A', 'B', '2026-03-10'), debit: null, fallback: money('10') };
      expect(resolveCarriedCosts([leg], historyOf([])).get('t')?.toString()).toBe('10');
    });

    it('keeps the stored cost when the source can no longer carry one', () => {
      const leg = { ...transfer('t', 'A', 'B', '2026-03-10'), fallback: money('10') };
      expect(resolveCarriedCosts([leg], historyOf([])).get('t')?.toString()).toBe('10');
    });

    it('keeps the stored cost through a swap that never unblocks, and a downstream leg reads it', () => {
      const history = [
        aTransaction().buy().at('A').on('2026-01-05').quantity('100').price('10').build(),
        aTransaction().buy().at('B').on('2026-01-05').quantity('100').price('20').build(),
      ];
      const aToB = { ...transfer('a-to-b', 'A', 'B', '2026-03-10'), fallback: money('12') };
      const bToA = transfer('b-to-a', 'B', 'A', '2026-03-10');
      // B then sends 200 on to C: B's 100 @ 20,00 (2.000,00) + 100 kept @ 12,00
      // (1.200,00) = 3.200,00 ÷ 200 = 16,00.
      const bToC = transfer('b-to-c', 'B', 'C', '2026-03-20', '200');

      const costs = resolveCarriedCosts([aToB, bToA, bToC], historyOf(history));

      expect(costs.get('a-to-b')?.toString()).toBe('12');
      expect(costs.has('b-to-a')).toBe(false);
      // Still blocked by the swap when the loop ends, so it carries nothing.
      expect(costs.has('b-to-c')).toBe(false);
    });
  });

  it('withCarriedCost restates the total: 100 × 5,00 + 1,00 = 501,00', () => {
    const credit = aTransaction().transferIn().quantity('100').price('0').fees('1').build();
    const carried = withCarriedCost(credit, money('5'));
    expect(carried.unitPrice.toString()).toBe('5');
    expect(carried.totalValue.toString()).toBe('501');
  });

  /**
   * #135 — a carried cost is a division and repeats as often as not. Writing
   * the full-precision quotient made the position a commit caches disagree
   * with the position a rebuild folds from the same rows read back at
   * `NUMERIC(20,8)`, which `verifyPositions` reports as drift (DM-4).
   */
  it('withCarriedCost writes the price at the scale the column holds', () => {
    const credit = aTransaction().transferIn().quantity('3').price('0').build();
    // 31,00 ÷ 3 = 10,333… — eight places, rounded half-up as Postgres casts.
    const carried = withCarriedCost(credit, money('31').dividedBy(Quantity.fromString('3')));
    expect(carried.unitPrice.toString()).toBe('10.33333333');
    expect(asStored(carried.unitPrice)).toBe('10.33333333');
    expect(carried.totalValue.toString()).toBe('30.99999999');
  });

  /**
   * #135 — one leg of a same-position pair applied alone is not a partial
   * import but a loss: the shares leave and nothing records their return.
   * Asked of the relation rather than of a formed pair, because the shapes
   * where no pair forms are exactly the ones where two debits could empty a
   * position between them.
   */
  describe('debitsHeldBack', () => {
    const asset = AssetId.generate();
    const other = AssetId.generate();
    const origem = InstitutionId.generate();
    const destino = InstitutionId.generate();

    const at = (id: string, overrides: Partial<TransferLeg> = {}): TransferLeg => ({
      id,
      assetId: asset,
      institutionId: origem,
      tradeDate: BusinessDate.of('2026-03-10'),
      quantity: Quantity.fromString('100'),
      ...overrides,
    });

    it('holds back a debit whose same-position credit is unsettled', () => {
      expect([...debitsHeldBack([at('debit')], [at('credit')])]).toEqual(['debit']);
    });

    it('releases it when no credit is left unsettled', () => {
      expect([...debitsHeldBack([at('debit')], [])]).toEqual([]);
    });

    it('never holds back a cross-institution debit: the shares genuinely left that broker', () => {
      expect([
        ...debitsHeldBack([at('debit', { institutionId: destino })], [at('credit')]),
      ]).toEqual([]);
    });

    it.each<[string, Partial<TransferLeg>]>([
      ['another asset', { assetId: other }],
      ['another day', { tradeDate: BusinessDate.of('2026-03-11') }],
      ['another quantity', { quantity: Quantity.fromString('99') }],
      ['no institution', { institutionId: null }],
    ])('does not match an unsettled credit of %s', (_label, overrides) => {
      expect([...debitsHeldBack([at('debit')], [at('credit', overrides)])]).toEqual([]);
    });

    /**
     * Review finding 1A, as amended by #145. Two same-position pairs of equal
     * quantity on one date now pair as a round trip — but a rule asked of
     * formed pairs alone once let both debits through and emptied the
     * position, so the hold-back still reads the relation.
     */
    it('pairs a same-position round trip, and still holds its debits back while the credits are unsettled', () => {
      const credits = [at('credit-2'), at('credit-1')];
      // #145 follow-up: interchangeable legs pair in id order.
      expect([...pairTransfers(credits, [at('debit-2'), at('debit-1')])]).toEqual([
        ['credit-1', 'debit-1'],
        ['credit-2', 'debit-2'],
      ]);
      expect([...debitsHeldBack([at('debit-1'), at('debit-2')], credits)].sort()).toEqual([
        'debit-1',
        'debit-2',
      ]);
    });

    it('pairs nothing where a credit sits at another institution or carries a price, whatever the order', () => {
      const clear = at('c2', { institutionId: destino });
      const debits = [at('d1'), at('d2')];
      expect(pairTransfers([at('c1'), clear], debits).size).toBe(0);
      expect(pairTransfers([clear, at('c1')], debits).size).toBe(0);
      expect(pairTransfers([at('c1'), at('c2', { priceStated: true })], debits).size).toBe(0);
    });

    it('pairs nothing where the round trip is unequal, or a debit sits at another institution', () => {
      expect(pairTransfers([at('c1'), at('c2'), at('c3')], [at('d1'), at('d2')]).size).toBe(0);
      expect(
        pairTransfers([at('c1'), at('c2')], [at('d1'), at('d2', { institutionId: destino })]).size,
      ).toBe(0);
    });

    /**
     * Review finding 1B. A same-institution debit competing with a
     * cross-institution one: the credit pairs with neither, and the
     * same-position debit must still be held back while the other applies.
     */
    it('holds back only the same-position debit when a cross-institution one competes', () => {
      const credit = at('credit');
      const debits = [at('own'), at('elsewhere', { institutionId: destino })];
      expect(pairTransfers([credit], debits).size).toBe(0);
      expect([...debitsHeldBack(debits, [credit])]).toEqual(['own']);
    });
  });
});
