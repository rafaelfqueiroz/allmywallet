import { formatBusinessDate } from '@/i18n/format';
import { B3_GUIDE_VERIFIED_AS_OF } from '@/components/onboarding/verification';
import { Text } from '@/components/ui/text';

/**
 * SPEC-020 BR-020-24 — "each diagram set carries a 'verified against B3 as of
 * `<date>`' stamp, visible to the user." Rendered as plain visible text, not a
 * tooltip or a footnote: staleness is meant to be seen, not discovered.
 *
 * A plain synchronous component (DS-02): `label` is the translated prefix
 * ("Verificado na B3 em"), supplied by the caller's own `getTranslations`
 * call, and `formatBusinessDate` — a pure function, not a next-intl call — is
 * applied here to `B3_GUIDE_VERIFIED_AS_OF` directly. AR-47/BR-016-18:
 * `dd/mm/yyyy` through the shared formatter, never a `BusinessDate`
 * interpolated raw into an ICU message, which would render the ISO string it
 * is stored as and read as a machine's date rather than a Brazilian one.
 */
export function GuideStamp({ label }: { readonly label: string }) {
  return (
    <Text as="p" size="xs" tone="muted">
      {label} {formatBusinessDate(B3_GUIDE_VERIFIED_AS_OF)}
    </Text>
  );
}
