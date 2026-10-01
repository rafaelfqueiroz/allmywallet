import { describe, expect, it } from 'vitest';
import type { Transaction } from '@/core/ledger/transaction';
import { naturalKeyFor } from '@/core/ledger/natural-key';
import { aTransaction } from '@/core/ledger/test-support/transaction-builder';
import {
  internalLedgerTransferIds,
  isCarriedCredit,
  isImportOwned,
  pairLedgerTransfers,
} from '@/core/ledger/transfer-pairs';

/** Two identical-quantity occurrences on each side, priced differently. */
function roundTrip(): Transaction[] {
  return [
    aTransaction().transferIn().at('Clear').quantity('3').price('12').build(),
    aTransaction().transferIn().at('Clear').quantity('3.00').price('14').build(),
    aTransaction().transferOut().at('Clear').quantity('3').price('0').build(),
    aTransaction().transferOut().at('Clear').quantity('3.000').price('0').build(),
  ];
}

describe('SPEC-013 BR-013-08 / DL-013-11 — flow classification is distinct from cost carry', () => {
  it('balances complete exact-quantity occurrence groups irrespective of price or origin', () => {
    // 2 credits × 3 shares = 2 debits × 3 shares: all 4 legs are internal.
    // The credit prices 12 and 14 cannot choose a carried cost, so no cost pair.
    const manual = roundTrip();
    const imported = manual.map((t) => ({
      ...t,
      importBatchId: aTransaction().imported().build().importBatchId,
      isManual: false,
      naturalKey: naturalKeyFor(t),
    }));
    for (const rows of [manual, imported, imported.map((t) => ({ ...t, isUserModified: true }))]) {
      expect(pairLedgerTransfers(rows).size).toBe(0);
      expect([...internalLedgerTransferIds(rows)].sort()).toEqual(rows.map((t) => t.id).sort());
      expect([...internalLedgerTransferIds([...rows].reverse())].sort()).toEqual(
        rows.map((t) => t.id).sort(),
      );
    }
  });

  it.each([
    ['two debits against one credit', (rows: Transaction[]) => rows.slice(1)],
    ['one debit against two credits', (rows: Transaction[]) => rows.slice(0, 3)],
    [
      'split quantities 3 + 3 against 6',
      (rows: Transaction[]) => [
        aTransaction().transferIn().at('Clear').quantity('6').price('12').build(),
        ...rows.slice(2),
      ],
    ],
  ])('does not choose a partial or aggregated match: %s', (_name, shape) => {
    // Unequal occurrence counts have 0 justified pairs; 3 + 3 = 6 is not
    // an equal-quantity occurrence. Residual prices cannot decide a match.
    expect(internalLedgerTransferIds(shape(roundTrip())).size).toBe(0);
  });

  it.each([
    ['unknown institution', (t: Transaction) => ({ ...t, institutionId: null })],
    ['unclassified credits', (t: Transaction) => ({ ...t, status: 'unclassified' as const })],
    ['superseded credits', (t: Transaction) => ({ ...t, status: 'superseded' as const })],
    [
      'different institution',
      (t: Transaction) => ({ ...t, institutionId: aTransaction().at('XP').build().institutionId }),
    ],
    [
      'different asset',
      (t: Transaction) => ({ ...t, assetId: aTransaction().of('VALE3').build().assetId }),
    ],
    [
      'different date',
      (t: Transaction) => ({ ...t, tradeDate: aTransaction().on('2026-01-06').build().tradeDate }),
    ],
    [
      'different quantity',
      (t: Transaction) => ({ ...t, quantity: aTransaction().quantity('4').build().quantity }),
    ],
  ])('requires an active same-position exact-quantity group: %s', (_name, alterCredit) => {
    // Both credits fail the stated identity or active-state condition:
    // 0 complete groups and 0 one-to-one cost-carry pairs remain.
    const rows = roundTrip().map((t) => (t.type === 'transfer_in' ? alterCredit(t) : t));
    expect(internalLedgerTransferIds(rows).size).toBe(0);
  });

  it('keeps cost pairs, balanced round trips and external groups separate', () => {
    // q=5 Clear→XP: one authoritative cost pair = 2 internal legs.
    // q=3 Clear→Clear: 2+2 occurrences = 4 internal legs, no cost pairs.
    // q=7 Clear→Clear: 1 credit against 2 debits = 0 internal legs.
    const paired = [
      aTransaction().transferIn().at('XP').quantity('5').price('15').build(),
      aTransaction().transferOut().at('Clear').quantity('5').build(),
    ];
    const trip = roundTrip();
    const external = [
      aTransaction().transferIn().at('Clear').quantity('7').price('12').build(),
      aTransaction().transferOut().at('Clear').quantity('7').build(),
      aTransaction().transferOut().at('Clear').quantity('7').build(),
    ];
    const rows = [...paired, ...trip, ...external, aTransaction().buy().at('Clear').build()];
    expect(pairLedgerTransfers(rows).size).toBe(1);
    expect([...internalLedgerTransferIds(rows)].sort()).toEqual(
      [...paired, ...trip].map((t) => t.id).sort(),
    );
    expect(internalLedgerTransferIds([]).size).toBe(0);
  });
});

describe('SPEC-005 BR-005-20a — stored cost provenance is unchanged', () => {
  it('recognises carry only on an untouched import credit keyed differently from its stored cost', () => {
    // Carry is a Boolean provenance fact, not a comparison of monetary totals:
    // 1 untouched imported credit with a mismatched key is carried, all others 0.
    const carried = aTransaction().transferIn().imported().price('12').build();
    expect(isCarriedCredit(carried)).toBe(true);
    expect(isCarriedCredit({ ...carried, naturalKey: naturalKeyFor(carried) })).toBe(false);
    expect(isCarriedCredit({ ...carried, isManual: true })).toBe(false);
    expect(isCarriedCredit({ ...carried, isUserModified: true })).toBe(false);
    expect(isCarriedCredit(aTransaction().transferOut().imported().build())).toBe(false);
    expect(isImportOwned(aTransaction().transferIn().build())).toBe(false);
  });
});
