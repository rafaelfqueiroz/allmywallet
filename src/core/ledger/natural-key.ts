import type { BusinessDate } from '@/core/shared/clock';
import type { AssetId, InstitutionId } from '@/core/shared/ids';
import type { Money, Quantity } from '@/core/shared/money';
import type { TransactionType } from '@/core/ledger/transaction';

/**
 * SPEC-006 BR-006-04: `natural_key` is unique per user, enforced by a database
 * constraint (DM-1). It is what makes a re-import idempotent — SPEC-005 looks
 * a row up by this key to decide whether it has seen it before.
 *
 * The key is a readable composite rather than a hash, deliberately. It carries
 * no personal data (ids, a date, a type and two decimals), so there is nothing
 * to protect by digesting it, and when a duplicate-detection question comes up
 * in support the key can be read directly instead of recomputed.
 *
 * Every component is UUID, ISO-8601 date, a fixed enum member or a plain
 * decimal literal — none of which can contain the separator, so the encoding
 * is unambiguous and two different transactions cannot collide by punctuation.
 *
 * The decimals are `toString()`, which is `Money`'s full-precision plain form
 * (never exponential, never a float — AR-06/AR-10). `1e-8` and `0.00000001`
 * must not produce two different keys for the same trade.
 */
export interface NaturalKeyParts {
  readonly assetId: AssetId;
  readonly institutionId: InstitutionId | null;
  readonly type: TransactionType;
  readonly tradeDate: BusinessDate;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
}

export function naturalKeyFor(parts: NaturalKeyParts): string {
  return [
    parts.tradeDate,
    parts.assetId,
    parts.institutionId ?? '',
    parts.type,
    parts.quantity.toString(),
    parts.unitPrice.toString(),
  ].join('|');
}
