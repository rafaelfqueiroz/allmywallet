import { customType } from 'drizzle-orm/pg-core';
import { Money, Quantity } from '@/core/shared/money';

/**
 * AR-07: a Drizzle custom type parses `NUMERIC` to `Money`/`Quantity` on read
 * and serialises on write, so money never exists as a JS `number` at any point
 * in its lifecycle.
 *
 * This is the seam where corruption would otherwise enter: `node-postgres`
 * hands `NUMERIC` back as a string, and the natural-looking thing to do with a
 * string that holds a price is `Number(...)`. Doing it here, once, wrong, would
 * be indistinguishable from doing it everywhere.
 */

const NUMERIC_SPEC = 'numeric(20, 8)';

export const money = customType<{ data: Money; driverData: string }>({
  dataType: () => NUMERIC_SPEC,
  fromDriver: (value) => Money.fromString(value),
  toDriver: (value) => value.toString(),
});

export const quantity = customType<{ data: Quantity; driverData: string }>({
  dataType: () => NUMERIC_SPEC,
  fromDriver: (value) => Quantity.fromString(value),
  toDriver: (value) => value.toString(),
});

/**
 * A ratio or rate — a split factor, a percentage of CDI. Not money, not a share
 * count, but subject to the same no-float rule.
 */
export const rate = customType<{ data: Quantity; driverData: string }>({
  dataType: () => NUMERIC_SPEC,
  fromDriver: (value) => Quantity.fromString(value),
  toDriver: (value) => value.toString(),
});
