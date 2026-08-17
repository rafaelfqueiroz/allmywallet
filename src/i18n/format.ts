import type { Money, Quantity } from '@/core/shared/money';
import type { BusinessDate } from '@/core/shared/clock';
import { DEFAULT_LOCALE } from '@/i18n/request';

/**
 * AR-09/AR-47: this is the only place rounding is permitted, and the only place
 * currency and dates are formatted. Never inline `toLocaleString` — the point
 * of a single formatter is that `R$ 1.234,56` and `dd/mm/yyyy` are decided once.
 */

const currencyFormatter = new Intl.NumberFormat(DEFAULT_LOCALE, {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const percentFormatter = new Intl.NumberFormat(DEFAULT_LOCALE, {
  style: 'percent',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Share counts can be fractional (FIIs, fractional lots) but rarely need 8 dp. */
const quantityFormatter = new Intl.NumberFormat(DEFAULT_LOCALE, {
  minimumFractionDigits: 0,
  maximumFractionDigits: 8,
});

/**
 * `Number(...)` appears here and nowhere else. It is safe *only* because this
 * is the terminal display step: the value has already been persisted and
 * computed at full precision, and nothing downstream reads what this returns.
 */
export function formatCurrency(value: Money): string {
  return currencyFormatter.format(Number(value.toString()));
}

export function formatQuantity(value: Quantity): string {
  return quantityFormatter.format(Number(value.toString()));
}

/**
 * Takes a value **already expressed in percentage points** — 118 renders as
 * "118,00%".
 *
 * Distinct from `formatPercent` because `Intl`'s `style: 'percent'` multiplies
 * by 100, so handing it a figure that is already a percentage multiplies
 * twice. SPEC-012's "% do CDI" is the one measure computed that way (its
 * domain type is `Quantity`, not `Rate`, precisely because it is not a
 * fraction), and it reached the screen as `11.800,00%` for a portfolio that
 * had beaten CDI by 18%.
 */
const percentPointsFormatter = new Intl.NumberFormat(DEFAULT_LOCALE, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatPercentPoints(points: Money | Quantity): string {
  return `${percentPointsFormatter.format(Number(points.toString()))}%`;
}

/** Takes a fraction — 0.1234 renders as "12,34%". */
export function formatPercent(fraction: Money | Quantity): string {
  return percentFormatter.format(Number(fraction.toString()));
}

/** AR-29: business dates carry no time and no zone, so this is pure string work. */
export function formatBusinessDate(date: BusinessDate): string {
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

export function formatDateTime(instant: Date): string {
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  }).format(instant);
}
