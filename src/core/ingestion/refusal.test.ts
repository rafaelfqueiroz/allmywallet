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
    // SPEC-005 BR-005-24: no unclassified rows on the position at all, so the
    // shortfall traces to history that precedes what was imported.
    expect(refusal.likelyCause).toBe('missing_history');
  });

  it('a sale with no history at all held nothing, and traces to missing history', () => {
    const refusal = explainRefusal(row('sell', '2026-02-01', '5'), [], userId, now, today);
    expect(refusal.kind === 'insufficient_quantity' && refusal.held.toString()).toBe('0');
    expect(refusal.kind === 'insufficient_quantity' && refusal.likelyCause).toBe('missing_history');
  });

  describe('SPEC-005 BR-005-24 — likely cause of an insufficient_quantity refusal', () => {
    // A stored unclassified row's natural key keeps the raw B3 string as its
    // last `|`-separated component (BR-005-17) — `corporateEventMovementOfKey`
    // reads exactly that suffix.
    const unclassified = (naturalKeySuffix: string) => ({
      ...aTransaction().transferIn().on('2026-01-10').quantity('3').status('unclassified').build(),
      naturalKey: `2026-01-10|PETR4|unclassified|${naturalKeySuffix}`,
    });

    it('a shortfall on a position holding an unclassified desdobro names the corporate event', () => {
      const refusal = explainRefusal(
        row('transfer_out', '2026-02-01', '30'),
        [held10(), unclassified('Desdobro')],
        userId,
        now,
        today,
      );
      expect(refusal.kind === 'insufficient_quantity' && refusal.likelyCause).toBe(
        'uncaptured_corporate_event',
      );
    });

    it('a shortfall on a position holding an unclassified grupamento names the corporate event', () => {
      const refusal = explainRefusal(
        row('transfer_out', '2026-02-01', '30'),
        [held10(), unclassified('Grupamento')],
        userId,
        now,
        today,
      );
      expect(refusal.kind === 'insufficient_quantity' && refusal.likelyCause).toBe(
        'uncaptured_corporate_event',
      );
    });

    it('a shortfall on a position holding an unclassified non-corporate-event row names unclassified rows', () => {
      // `Transferência` alone (no direction resolved) is not one of the
      // named corporate-event strings — an ordinary unclassified row.
      const refusal = explainRefusal(
        row('transfer_out', '2026-02-01', '30'),
        [held10(), unclassified('Transferência')],
        userId,
        now,
        today,
      );
      expect(refusal.kind === 'insufficient_quantity' && refusal.likelyCause).toBe(
        'unclassified_rows',
      );
    });

    it('a shortfall on a position holding only active rows traces to missing history', () => {
      const refusal = explainRefusal(
        row('transfer_out', '2026-02-01', '30'),
        [held10()],
        userId,
        now,
        today,
      );
      expect(refusal.kind === 'insufficient_quantity' && refusal.likelyCause).toBe(
        'missing_history',
      );
    });

    it('a corporate-event unclassified row wins over a plain unclassified row on the same position', () => {
      const refusal = explainRefusal(
        row('transfer_out', '2026-02-01', '30'),
        [held10(), unclassified('Transferência'), unclassified('Fração em Ativos')],
        userId,
        now,
        today,
      );
      expect(refusal.kind === 'insufficient_quantity' && refusal.likelyCause).toBe(
        'uncaptured_corporate_event',
      );
    });
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

  /**
   * #135 — B3's same-institution `Transferência` pair. The debit replays
   * perfectly well against the position it is about to empty, which is why
   * this is asked before the replay rather than read off its failure.
   */
  describe('BR-005-20a — one leg of a same-position pair', () => {
    const unresolvedCredit = () =>
      aTransaction()
        .transferIn()
        .on('2026-02-01')
        .quantity('10')
        .price('0')
        .status('unclassified')
        .build();

    it('names the pair rather than letting the debit through', () => {
      expect(
        explainRefusal(
          row('transfer_out', '2026-02-01', '10'),
          [held10(), unresolvedCredit()],
          userId,
          now,
          today,
        ),
      ).toEqual({ kind: 'unresolved_transfer_pair', date: '2026-02-01' });
    });

    it('reads as applicable once the credit has taken its cost', () => {
      const carried = { ...unresolvedCredit(), status: 'active' as const };
      expect(
        explainRefusal(
          row('transfer_out', '2026-02-01', '10'),
          [held10(), carried],
          userId,
          now,
          today,
        ),
      ).toEqual({ kind: 'applicable' });
    });

    it('ignores an unclassified credit of another date or quantity', () => {
      const elsewhere = { ...unresolvedCredit(), tradeDate: BusinessDate.of('2026-02-02') };
      expect(
        explainRefusal(
          row('transfer_out', '2026-02-01', '10'),
          [held10(), elsewhere],
          userId,
          now,
          today,
        ).kind,
      ).toBe('applicable');
    });
  });

  it('a row dated after today is malformed', () => {
    expect(
      explainRefusal(row('transfer_out', '2026-12-01', '1'), [held10()], userId, now, today).kind,
    ).toBe('malformed');
  });

  it('a grupamento with a zero ratio is malformed', () => {
    expect(
      explainRefusal(row('grupamento', '2026-02-01', '0', '0'), [held10()], userId, now, today)
        .kind,
    ).toBe('malformed');
  });
});
