import { getTranslations } from 'next-intl/server';
import { formatBusinessDate } from '@/i18n/format';
import { B3_GUIDE_VERIFIED_AS_OF } from '@/components/onboarding/verification';
import { Text } from '@/components/ui/text';

/**
 * SPEC-020 BR-020-24 — "each diagram set carries a 'verified against B3 as of
 * `<date>`' stamp, visible to the user." Rendered as plain visible text, not a
 * tooltip or a footnote: staleness is meant to be seen, not discovered.
 *
 * AR-47/BR-016-18: `dd/mm/yyyy` through the shared formatter — interpolating a
 * `BusinessDate` directly into an ICU message would render the ISO string it
 * is stored as, which reads as a machine's date rather than a Brazilian one.
 */
export async function GuideStamp() {
  const t = await getTranslations('onboarding.guide');

  return (
    <Text as="p" size="xs" tone="muted">
      {t('stamp.verifiedAsOf', { date: formatBusinessDate(B3_GUIDE_VERIFIED_AS_OF) })}
    </Text>
  );
}
