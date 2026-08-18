import { describe, expect, it } from 'vitest';
import { Quantity } from '@/core/shared/money';
import type { Money } from '@/core/shared/money';
import { assetIdOf, money } from '@/core/reporting/test-support';
import type { UnflaggedRow } from '@/core/reporting/composition/ports';
import {
  concentrationThreshold,
  flagConcentration,
} from '@/core/reporting/composition/concentration';

/**
 * SPEC-015 BR-015-05/06, AC "a holding exceeding the configured threshold is
 * flagged; changing the threshold in user settings changes which holdings
 * flag".
 *
 * The wording of the flag is **not** tested here and cannot be: BR-015-06 and
 * the spec's own acceptance criterion say it is "verified by review, not just
 * by test". No assertion distinguishes description from advice. What is
 * testable is that the product holds no opinion of its own — the threshold
 * comes in as a parameter and comes back out with the result.
 */

function aRow(overrides: Partial<UnflaggedRow> & { readonly share: Money | null }): UnflaggedRow {
  return {
    assetId: assetIdOf('1'),
    assetCode: 'PETR4',
    assetName: 'Petrobras PN',
    assetClass: 'stock',
    sector: null,
    quantity: Quantity.fromString('1'),
    value: money('100'),
    costBasis: money('100'),
    averagePrice: money('100'),
    currentPrice: money('100'),
    unrealizedGain: money('0'),
    estimated: false,
    carriedForward: false,
    priceDate: null,
    needsAttention: null,
    basis: null,
    ...overrides,
  };
}

describe('concentrationThreshold — the registry percent, as a share', () => {
  it('converts the default 20 into the fraction shares are expressed in', () => {
    expect(concentrationThreshold(20).toString()).toBe('0.2');
  });

  it('handles the range ends the registry permits', () => {
    expect(concentrationThreshold(1).toString()).toBe('0.01');
    expect(concentrationThreshold(100).toString()).toBe('1');
  });
});

describe('flagConcentration — BR-015-05', () => {
  it('flags a holding above the threshold and leaves the rest alone', () => {
    const { rows, concentration } = flagConcentration(
      [
        aRow({ assetId: assetIdOf('1'), assetCode: 'PETR4', share: money('0.45') }),
        aRow({ assetId: assetIdOf('2'), assetCode: 'ITSA4', share: money('0.35') }),
        aRow({ assetId: assetIdOf('3'), assetCode: 'HGLG11', share: money('0.20') }),
      ],
      40,
    );

    expect(rows.map((row) => row.concentrated)).toEqual([true, false, false]);
    expect(concentration.flagged).toEqual([assetIdOf('1')]);
    // The screen has to name the number to keep this a fact rather than a
    // verdict — so the result carries it.
    expect(concentration.thresholdPct).toBe(40);
  });

  it('does not flag a holding sitting exactly on the threshold', () => {
    /**
     * BR-015-05 says **exceeds**. `>` and `>=` are one character apart and the
     * difference is invisible on every portfolio except the one it is wrong
     * for — a user who set 20 and holds exactly 20,00 % is not over their own
     * limit.
     */
    const { rows } = flagConcentration([aRow({ share: money('0.2') })], 20);
    expect(rows[0]?.concentrated).toBe(false);
  });

  it('flags a hair above it', () => {
    const { rows } = flagConcentration([aRow({ share: money('0.20000001') })], 20);
    expect(rows[0]?.concentrated).toBe(true);
  });

  it('AC: changing the threshold changes which holdings flag', () => {
    const rows = [
      aRow({ assetId: assetIdOf('1'), assetCode: 'PETR4', share: money('0.45') }),
      aRow({ assetId: assetIdOf('2'), assetCode: 'ITSA4', share: money('0.35') }),
      aRow({ assetId: assetIdOf('3'), assetCode: 'HGLG11', share: money('0.20') }),
    ];

    expect(flagConcentration(rows, 50).concentration.flagged).toEqual([]);
    expect(flagConcentration(rows, 40).concentration.flagged).toEqual([assetIdOf('1')]);
    expect(flagConcentration(rows, 30).concentration.flagged).toEqual([
      assetIdOf('1'),
      assetIdOf('2'),
    ]);
    expect(flagConcentration(rows, 10).concentration.flagged).toEqual([
      assetIdOf('1'),
      assetIdOf('2'),
      assetIdOf('3'),
    ]);
  });

  it('never flags a row whose share is undefined', () => {
    // An empty scope: nothing can exceed a share of a portfolio holding
    // nothing, and the alternative is flagging every row of an empty report.
    const { rows, concentration } = flagConcentration([aRow({ share: null })], 1);

    expect(rows[0]?.concentrated).toBe(false);
    expect(concentration.flagged).toEqual([]);
  });

  it('returns the flagged ids in the order the table lists them', () => {
    const { concentration } = flagConcentration(
      [
        aRow({ assetId: assetIdOf('2'), assetCode: 'ITSA4', share: money('0.6') }),
        aRow({ assetId: assetIdOf('1'), assetCode: 'PETR4', share: money('0.4') }),
      ],
      30,
    );
    expect(concentration.flagged).toEqual([assetIdOf('2'), assetIdOf('1')]);
  });
});
