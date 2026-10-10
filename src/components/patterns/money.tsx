import type * as React from 'react';
import type { Money as MoneyValue, Quantity } from '@/core/shared/money';
import { formatCurrency, formatPercent, formatPercentPoints, formatQuantity } from '@/i18n/format';
import { MoneyMask } from '@/components/patterns/money-mask';
import { cn } from '@/lib/utils';

/**
 * DS-09 / AR-09 — the single place a monetary figure becomes text.
 *
 * Two rules are enforced here rather than asked of every screen:
 *
 * 1. **Rounding happens once, at display**, in the i18n formatter. Nothing
 *    upstream rounds, and nothing downstream reads what this renders.
 * 2. **Colour never carries meaning alone.** `signed` colours the figure
 *    *and* prefixes an explicit `+`/`−`. WCAG 1.4.1 is satisfied by the
 *    redundant cue, not by abandoning the green-up/red-down convention every
 *    Brazilian broker uses (DL-05). A screen cannot opt out of the sign while
 *    keeping the colour, because the two are the same prop.
 *
 * `tabular-nums` is unconditional: a column of proportional digits does not
 * line up on the decimal point, which makes a ledger unreadable (DS-13).
 */
export type MoneyProps = Omit<React.ComponentProps<'span'>, 'children'> & {
  value: MoneyValue | Quantity;
  /**
   * `currency` renders R$; `quantity` a bare number; `percent` takes a
   * **fraction** (0,1234 → "12,34%"); `percentPoints` takes a value already
   * in percentage points (118 → "118,00%").
   *
   * The last two are separate kinds rather than one, because `Intl`'s percent
   * style multiplies by 100 — so the distinction is not cosmetic, and a call
   * site that guesses wrong is off by two orders of magnitude with no visible
   * type error. SPEC-012's "% do CDI" is a `Quantity` for that reason.
   */
  kind?: 'currency' | 'quantity' | 'percent' | 'percentPoints';
  /** Colour by sign and prefix an explicit +/−. For deltas, never for balances. */
  signed?: boolean;
  /**
   * SPEC-022 BR-022-24/26 — render a `currency` figure as the fixed
   * placeholder instead. Quantities and percentages ignore it (DL-022-07).
   *
   * Pages never pass this: they import `Money` from `@/app/money`, which reads
   * the account's `ui.hide_values` on the server. Only a Client Component sets
   * it, from `useMasked()`.
   */
  masked?: boolean;
};

function format(value: MoneyValue | Quantity, kind: NonNullable<MoneyProps['kind']>): string {
  if (kind === 'percent') return formatPercent(value);
  if (kind === 'percentPoints') return formatPercentPoints(value);
  if (kind === 'quantity') return formatQuantity(value as Quantity);
  return formatCurrency(value as MoneyValue);
}

export function Money({
  value,
  kind = 'currency',
  signed = false,
  masked = false,
  className,
  ...props
}: MoneyProps) {
  const negative = value.isNegative();
  const zero = value.isZero();
  // A masked figure drops its sign and its colour too. Both would say whether
  // the amount is exactly zero, and the sign would make a zero narrower than
  // every other value — BR-022-26 is one width for every value. Direction is
  // still on screen wherever a percentage sits beside the amount (DL-022-07).
  const hidden = masked && kind === 'currency';
  const showSign = signed && !hidden;

  // The sign is rendered as text, so the formatter never has to produce one and
  // "-R$ 10,00" versus "R$ -10,00" stops being a per-call-site decision.
  // `negated()` rather than `abs()`: Quantity has no `abs`, and negating a
  // known-negative value is the same thing without widening the union.
  const magnitude = hidden ? undefined : format(signed && negative ? value.negated() : value, kind);
  const prefix = !showSign || zero ? '' : negative ? '−' : '+';

  return (
    <span
      data-slot="money"
      data-sign={showSign ? (zero ? 'zero' : negative ? 'negative' : 'positive') : undefined}
      data-masked={hidden ? '' : undefined}
      className={cn(
        'tabular-nums',
        hidden && 'whitespace-nowrap',
        showSign && !zero && (negative ? 'text-negative' : 'text-positive'),
        className,
      )}
      {...props}
    >
      {prefix}
      {hidden ? <MoneyMask /> : magnitude}
    </span>
  );
}
