import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { Money, Quantity } from '@/core/shared/money';
import { naturalKeyFor, type NaturalKeyParts } from '@/core/ledger/natural-key';
import { assetIdFor, institutionIdFor } from '@/core/ledger/test-support/transaction-builder';

/** SPEC-006 BR-006-04 — unique per user, enforced by a database constraint. */
describe('naturalKeyFor', () => {
  function parts(overrides: Partial<NaturalKeyParts> = {}): NaturalKeyParts {
    return {
      assetId: assetIdFor('PETR4'),
      institutionId: institutionIdFor('Clear'),
      type: 'buy',
      tradeDate: BusinessDate.of('2026-01-05'),
      quantity: Quantity.fromString('100'),
      unitPrice: Money.fromString('32.15'),
      ...overrides,
    };
  }

  it('is deterministic — the same trade always produces the same key', () => {
    expect(naturalKeyFor(parts())).toBe(naturalKeyFor(parts()));
  });

  it.each([
    ['the date', { tradeDate: BusinessDate.of('2026-01-06') }],
    ['the asset', { assetId: assetIdFor('VALE3') }],
    ['the institution', { institutionId: institutionIdFor('Rico') }],
    ['the type', { type: 'sell' as const }],
    ['the quantity', { quantity: Quantity.fromString('101') }],
    ['the price', { unitPrice: Money.fromString('32.16') }],
  ])('changes when %s changes', (_label, override) => {
    expect(naturalKeyFor(parts(override))).not.toBe(naturalKeyFor(parts()));
  });

  it('distinguishes "no institution" from a real one without colliding', () => {
    const none = naturalKeyFor(parts({ institutionId: null }));
    expect(none).not.toBe(naturalKeyFor(parts()));
    expect(none).toContain('||');
  });

  it('normalises equal decimals written differently', () => {
    // `100` and `100.00` are the same quantity, and 32,15 must not key
    // differently from 32,150. Two keys for one trade would defeat the
    // duplicate detection this exists for.
    expect(
      naturalKeyFor(
        parts({ quantity: Quantity.fromString('100.00'), unitPrice: Money.fromString('32.150') }),
      ),
    ).toBe(naturalKeyFor(parts()));
  });

  it('never emits exponential notation for a tiny quantity', () => {
    // `1e-8` and `0.00000001` are the same trade and must key identically.
    // Asserted on the quantity segment specifically: the asset UUID is hex and
    // can legitimately contain the substring "e-" itself.
    const key = naturalKeyFor(parts({ quantity: Quantity.fromString('0.00000001') }));
    const quantitySegment = key.split('|')[4];
    expect(quantitySegment).toBe('0.00000001');
  });

  it('carries no personal data — ids, a date, a type and two decimals', () => {
    // AR-39: this string reaches logs and support conversations.
    const key = naturalKeyFor(parts());
    expect(key.split('|')).toHaveLength(6);
    expect(key.startsWith('2026-01-05|')).toBe(true);
  });
});
