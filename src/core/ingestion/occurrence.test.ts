import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { AssetId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { importNaturalKeyFor, planOccurrences } from '@/core/ingestion/occurrence';
import { naturalKeyFor } from '@/core/ledger/natural-key';

const assetId = AssetId.generate();

describe('SPEC-005 BR-005-14..17 — planOccurrences', () => {
  it('a fresh file: two genuinely identical same-day trades both plan as new (BR-005-16)', () => {
    const rows = [{ naturalKey: 'K' }, { naturalKey: 'K' }];
    const planned = planOccurrences(rows, new Map());

    expect(planned[0]).toMatchObject({ occurrence: 1, isDuplicate: false });
    expect(planned[1]).toMatchObject({ occurrence: 2, isDuplicate: false });
  });

  it('re-importing the identical file: both rows are now duplicates (BR-005-17)', () => {
    const rows = [{ naturalKey: 'K' }, { naturalKey: 'K' }];
    // Both occurrences of K already exist in the ledger from the first import.
    const planned = planOccurrences(rows, new Map([['K', 2]]));

    expect(planned[0]).toMatchObject({ occurrence: 1, isDuplicate: true });
    expect(planned[1]).toMatchObject({ occurrence: 2, isDuplicate: true });
  });

  it('an overlapping re-import that also contains one genuinely new row: only the new one plans as new', () => {
    // File order: K, K, K — the first two are the same pair already
    // committed; the third is a real new trade made since.
    const rows = [{ naturalKey: 'K' }, { naturalKey: 'K' }, { naturalKey: 'K' }];
    const planned = planOccurrences(rows, new Map([['K', 2]]));

    expect(planned.map((r) => r.isDuplicate)).toEqual([true, true, false]);
    expect(planned[2]).toMatchObject({ occurrence: 3, isDuplicate: false });
  });

  it('different natural keys never share an occurrence counter', () => {
    const rows = [{ naturalKey: 'A' }, { naturalKey: 'B' }, { naturalKey: 'A' }];
    const planned = planOccurrences(rows, new Map());

    expect(planned[0]).toMatchObject({ occurrence: 1 });
    expect(planned[1]).toMatchObject({ occurrence: 1 });
    expect(planned[2]).toMatchObject({ occurrence: 2 });
  });

  it('a key absent from existingCounts behaves identically to an explicit 0', () => {
    const rows = [{ naturalKey: 'K' }];
    expect(planOccurrences(rows, new Map())).toEqual(planOccurrences(rows, new Map([['K', 0]])));
  });
});

describe('SPEC-005 — importNaturalKeyFor', () => {
  const parts = {
    assetId,
    institutionId: null,
    type: 'rendimento' as const,
    tradeDate: BusinessDate.of('2026-03-15'),
    quantity: Quantity.fromString('100'),
    unitPrice: Money.fromString('1.5'),
  };

  it('for a classified row, is exactly naturalKeyFor — reused, not reimplemented', () => {
    expect(importNaturalKeyFor(parts, null)).toBe(naturalKeyFor(parts));
  });

  it('for an unclassified row, disambiguates two different B3 types that would otherwise collide', () => {
    const iof = importNaturalKeyFor(parts, 'IOF');
    const fee = importNaturalKeyFor(parts, 'Taxa de Custódia');

    expect(iof).not.toBe(fee);
    // Both still start from the same naturalKeyFor base — the disambiguation
    // is additive, not a parallel key scheme.
    expect(iof.startsWith(naturalKeyFor(parts))).toBe(true);
    expect(fee.startsWith(naturalKeyFor(parts))).toBe(true);
  });

  it('the disambiguating suffix is normalised, so re-parsing the same raw type is stable', () => {
    expect(importNaturalKeyFor(parts, 'IOF')).toBe(importNaturalKeyFor(parts, '  iof  '));
  });
});
