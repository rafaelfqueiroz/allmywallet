import { beforeEach, describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { ImportBatchId, ImportRowId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type { TransactionType } from '@/core/ledger/transaction';
import {
  aTransaction,
  assetIdFor,
  institutionIdFor,
  resetTransactionSequence,
} from '@/core/ledger/test-support/transaction-builder';
import type { ImportRow } from '@/core/ingestion/ports';
import { explainRefusal } from '@/core/ingestion/refusal';

const userId = UserId.generate();
const now = new Date('2026-03-15T12:00:00-03:00');
const today = BusinessDate.of('2026-03-15');

function row(type: TransactionType, date: string, quantity: string, ratio: string | null = null) {
  const staged: ImportRow = {
    id: ImportRowId.generate(),
    batchId: ImportBatchId.generate(),
    raw: {},
    record: {
      kind: 'transaction',
      b3Type: 'Transferência',
      direction: 'debit',
      assetCode: 'PETR4',
      assetName: 'Petrobras PN',
      assetClass: 'stock',
      institutionName: 'Corretora Teste',
      tradeDate: BusinessDate.of(date),
      quantity: Quantity.fromString(quantity),
      unitPrice: Money.fromString('10'),
      priceStated: true,
      fees: Money.zero(),
      ratio: ratio === null ? null : Quantity.fromString(ratio),
    },
    assetId: assetIdFor('PETR4'),
    institutionId: institutionIdFor('Corretora Teste'),
    classification: 'invalid',
    naturalKey: `refused-${type}-${date}`,
    occurrence: 1,
    ledgerType: type,
    transactionId: null,
  };
  return staged;
}

describe('SPEC-005 #117 — explainRefusal, why a committed row is invalid', () => {
  beforeEach(() => {
    resetTransactionSequence();
  });

  const held10 = () => aTransaction().buy().on('2026-01-05').quantity('10').price('10').build();

  it('a debit larger than the holding names what was held, what it removes, and when', () => {
    const refusal = explainRefusal(
      row('transfer_out', '2026-02-01', '30'),
      [held10()],
      userId,
      now,
      today,
    );
    expect(refusal).toMatchObject({ kind: 'insufficient_quantity', date: '2026-02-01' });
    if (refusal.kind !== 'insufficient_quantity') return;
    expect(refusal.held.toString()).toBe('10');
    expect(refusal.requested.toString()).toBe('30');
  });

  it('a sale with no history at all held nothing', () => {
    const refusal = explainRefusal(row('sell', '2026-02-01', '5'), [], userId, now, today);
    expect(refusal.kind === 'insufficient_quantity' && refusal.held.toString()).toBe('0');
  });

  it('a row that fits but starves a later stored sale names that sale’s date', () => {
    const laterSale = aTransaction().sell().on('2026-03-01').quantity('10').price('12').build();
    expect(
      explainRefusal(
        row('transfer_out', '2026-02-01', '5'),
        [held10(), laterSale],
        userId,
        now,
        today,
      ),
    ).toEqual({ kind: 'conflicts_with_ledger', date: '2026-03-01' });
  });

  it('once the history is in, the row is applicable', () => {
    expect(
      explainRefusal(row('transfer_out', '2026-02-01', '10'), [held10()], userId, now, today),
    ).toEqual({ kind: 'applicable' });
  });

  it('a row the ledger already holds under its key and occurrence is applied', () => {
    const refused = row('transfer_out', '2026-02-01', '10');
    const stored = { ...held10(), naturalKey: refused.naturalKey as string, occurrence: 1 };
    expect(explainRefusal(refused, [stored], userId, now, today)).toEqual({ kind: 'applied' });
  });

  it('a superseded copy under the same key does not count as applied', () => {
    const refused = row('transfer_out', '2026-02-01', '10');
    const stored = {
      ...held10(),
      naturalKey: refused.naturalKey as string,
      occurrence: 1,
      status: 'superseded' as const,
    };
    expect(explainRefusal(refused, [held10(), stored], userId, now, today)).toEqual({
      kind: 'applicable',
    });
  });

  it('a row dated after today is malformed', () => {
    expect(
      explainRefusal(row('transfer_out', '2026-12-01', '1'), [held10()], userId, now, today).kind,
    ).toBe('malformed');
  });

  it('a row the fold refuses for another reason than quantity is malformed', () => {
    expect(
      explainRefusal(row('grupamento', '2026-02-01', '0', '0'), [held10()], userId, now, today)
        .kind,
    ).toBe('malformed');
  });
});
