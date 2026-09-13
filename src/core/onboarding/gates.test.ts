import { describe, expect, it } from 'vitest';
import { AssetId, ImportBatchId } from '@/core/shared/ids';
import { Quantity } from '@/core/shared/money';
import type { AttentionItem } from '@/core/dashboard/summary';
import { describeGate, type GateConsequence } from '@/core/onboarding/gates';

/**
 * SPEC-020 BR-020-15..19 — every "Needs attention" item states what is
 * wrong, what it prevents, and the one screen that resolves it.
 */

const BATCH = ImportBatchId.of('01920000-0000-7000-8000-0000000000f1');
const CDB = AssetId.of('01920000-0000-7000-8000-0000000000a1');
const PETR = AssetId.of('01920000-0000-7000-8000-0000000000a2');

const ITEMS: readonly AttentionItem[] = [
  { kind: 'import_rows', batchId: BATCH, count: 3 },
  { kind: 'fixed_income_rate', assetId: CDB, assetCode: 'CDB-BANCO-X', held: true },
  {
    kind: 'pending_allocation',
    assetId: PETR,
    assetCode: 'PETR4',
    quantity: Quantity.fromString('40'),
    reason: 'no_wallet',
  },
];

describe('describeGate (BR-020-16..19)', () => {
  it('describes an outstanding import row batch', () => {
    const description = describeGate({ kind: 'import_rows', batchId: BATCH, count: 3 });

    expect(description).toEqual({
      consequence: 'figures_unreliable',
      resolution: { screen: 'import_batch', batchId: BATCH },
    });
  });

  it('describes a held fixed-income contract missing a rate (BR-020-19)', () => {
    const description = describeGate({
      kind: 'fixed_income_rate',
      assetId: CDB,
      assetCode: 'CDB-BANCO-X',
      held: true,
    });

    expect(description).toEqual({
      consequence: 'portfolio_value_understated',
      resolution: { screen: 'fixed_income_contract', assetId: CDB },
    });
  });

  it('does not promise the rate fixes the total when the position is not imported yet', () => {
    const description = describeGate({
      kind: 'fixed_income_rate',
      assetId: CDB,
      assetCode: 'CDB-BANCO-X',
      held: false,
    });

    expect(description).toEqual({
      consequence: 'position_not_imported',
      resolution: { screen: 'fixed_income_contract', assetId: CDB },
    });
  });

  it('describes a purchase awaiting allocation', () => {
    const item = ITEMS[2];
    if (item === undefined || item.kind !== 'pending_allocation') throw new Error('fixture');
    const description = describeGate(item);

    expect(description).toEqual({
      consequence: 'allocation_missing',
      resolution: { screen: 'wallets' },
    });
  });

  /** BR-020-18 — every kind has a consequence and exactly one resolution. */
  it('gives every AttentionItem kind exactly one consequence and one resolution', () => {
    const seen = new Map<AttentionItem['kind'], GateConsequence>();
    for (const item of ITEMS) {
      const description = describeGate(item);
      expect(description.consequence).toBeTruthy();
      expect(description.resolution).toBeTruthy();
      seen.set(item.kind, description.consequence);
    }
    expect(seen.size).toBe(3);
  });
});
