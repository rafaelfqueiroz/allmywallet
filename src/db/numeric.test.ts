import { describe, expect, it } from 'vitest';
import { pgTable } from 'drizzle-orm/pg-core';
import { Money, Quantity } from '@/core/shared/money';
import { money, quantity, rate } from '@/db/numeric';

/**
 * AR-07: this custom type is the seam where float corruption would enter — `pg`
 * hands `NUMERIC` back as a string, and the natural-looking thing to do with a
 * string holding a price is `Number(...)`.
 *
 * The mapping functions only exist on a built column, so the assertions run
 * against a throwaway table. The full round-trip against real Postgres lives in
 * `tests/integration/numeric-round-trip.test.ts`; these need no database.
 */
const probe = pgTable('numeric_probe', {
  amount: money('amount'),
  shares: quantity('shares'),
  factor: rate('factor'),
});

describe('numeric column types', () => {
  it('declares NUMERIC(20,8), never float or money', () => {
    // AR-28. Postgres `money` has a locale-dependent scale, and `double
    // precision` is the thing this entire layer exists to avoid.
    expect(probe.amount.getSQLType()).toBe('numeric(20, 8)');
    expect(probe.shares.getSQLType()).toBe('numeric(20, 8)');
    expect(probe.factor.getSQLType()).toBe('numeric(20, 8)');
  });

  it('reads a driver string into Money without going through a number', () => {
    // Drizzle types the driver mappers as `unknown` in both directions, so the
    // narrowing is the assertion: if this stops being a Money the cast throws.
    const read = probe.amount.mapFromDriverValue('1234.56780000') as Money;
    expect(read).toBeInstanceOf(Money);
    expect(read.toString()).toBe('1234.5678');
  });

  it('writes Money back as a plain decimal string', () => {
    const written = probe.amount.mapToDriverValue(Money.fromString('0.00000001')) as string;
    expect(written).toBe('0.00000001');
    expect(written).not.toContain('e');
  });

  it('round-trips the smallest and largest values the column holds', () => {
    for (const literal of ['0.00000001', '99999999999.99999999', '-1234.5678']) {
      const driverValue = probe.amount.mapToDriverValue(Money.fromString(literal));
      const roundTripped = probe.amount.mapFromDriverValue(driverValue) as Money;
      expect(roundTripped.equals(Money.fromString(literal))).toBe(true);
    }
  });

  it('maps quantities and rates to their own wrapper', () => {
    expect(probe.shares.mapFromDriverValue('100.5')).toBeInstanceOf(Quantity);
    // A rate — 110% of CDI — is neither money nor a share count, but is subject
    // to the same no-float rule.
    expect((probe.factor.mapFromDriverValue('1.10000000') as Quantity).toString()).toBe('1.1');
  });

  it('rejects a driver value that is not a decimal literal', () => {
    // If Postgres ever hands back something unexpected, failing here beats
    // silently persisting NaN into a money column.
    expect(() => probe.amount.mapFromDriverValue('NaN')).toThrow(TypeError);
  });
});
