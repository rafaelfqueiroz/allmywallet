import { useTranslations } from 'next-intl';
import { MASKED_CURRENCY } from '@/i18n/masked';

/**
 * SPEC-022 BR-022-26 — a hidden amount. The placeholder is the same text for
 * every value, so its width cannot leak the number of digits; it is
 * `aria-hidden` because a screen reader would announce six bullets, and the
 * accessible name says what is actually there.
 *
 * Its own module so a Client Component — the holdings table, whose cells the
 * server has already masked — can render it without importing the formatters,
 * and the message catalogue behind them.
 */
export function MoneyMask() {
  const t = useTranslations('common');
  return (
    <>
      <span aria-hidden="true">{MASKED_CURRENCY}</span>
      <span className="sr-only">{t('hiddenValue')}</span>
    </>
  );
}
