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
