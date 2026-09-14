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
import { Money, Quantity } from '@/core/shared/money';
import type { Transaction } from '@/core/ledger/transaction';
import {
  aTransaction,
  resetTransactionSequence,
} from '@/core/ledger/test-support/transaction-builder';
import type { ImportRow, NormalizedTransactionRecord } from '@/core/ingestion/ports';
import {
  type CarryLeg,
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

  it.each<[string, Partial<TransferLeg>]>([
    ['has no institution', { institutionId: null }],
    ['is at the credit’s own institution', { institutionId: destination }],
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

  it('withCarriedCost restates the total: 100 × 5,00 + 1,00 = 501,00', () => {
    const credit = aTransaction().transferIn().quantity('100').price('0').fees('1').build();
    const carried = withCarriedCost(credit, money('5'));
    expect(carried.unitPrice.toString()).toBe('5');
    expect(carried.totalValue.toString()).toBe('501');
  });
});
