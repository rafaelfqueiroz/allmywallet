import { describe, expect, it } from 'vitest';
import { TRANSACTION_TYPES, isEarnings } from '@/core/ledger/transaction';
import { EARNING_TYPES } from '@/core/reporting/ports';

/**
 * SPEC-014 BR-014-11/13 — reporting's provento list and the ledger's must be
 * the same set.
 *
 * AR-01 forbids `core/reporting/` importing `core/ledger/`, so `EARNING_TYPES`
 * is restated there. The two halves of BR-014-13 then read different lists:
 * Proventos filters transactions by reporting's `EARNING_TYPES`, while
 * Patrimônio's `earningsToDate` is folded by the ledger's `isEarnings`
 * (`core/valuation/snapshot.ts`). A type added to one list and not the other —
 * exactly what #113's `leilao_fracoes` risked — would make the two reports
 * disagree about income with nothing else failing. This test sits outside
 * both modules so it may import both.
 */
describe('SPEC-014 BR-014-13 — reporting’s EARNING_TYPES equals the ledger’s earnings types', () => {
  it('names the same types, none missing on either side', () => {
    const ledger = TRANSACTION_TYPES.filter(isEarnings);
    expect([...EARNING_TYPES].sort()).toEqual([...ledger].sort());
  });
});
