import { getTranslations } from 'next-intl/server';
import type { BusinessDate } from '@/core/shared/clock';
import { formatBusinessDate } from '@/i18n/format';
import { Badge } from '@/components/ui/badge';
import { Text } from '@/components/ui/text';
import { Stack } from '@/components/layout/stack';

/**
 * SPEC-019 BR-019-24/26 / AC-14/15 — the achievement marker, shared by both
 * goal kinds.
 *
 * **`achievedOn` is the record of an event, not a live status.** It is set
 * once and never cleared (DL-019-05), so a goal that has since fallen back
 * below its amount still shows this marker and its original date — that is
 * BR-019-26, not a bug. `currentlyAchieved` is what tells the two situations
 * apart, and the wording changes accordingly: rendering the same sentence in
 * both cases would let a dipped goal read as "still above", which is a claim
 * this component must never make.
 *
 * A **date**, not an instant (AR-29). BR-019-24 asks for the date the goal was
 * achieved, which the progress reads off its own crossing point — a burn-up
 * sample or a provento's pay date — so there is no time of day to show and
 * inventing one would imply a precision the figure does not have.
 */
export async function AchievedMarker({
  achievedOn,
  currentlyAchieved,
}: {
  readonly achievedOn: BusinessDate | null;
  readonly currentlyAchieved: boolean;
}) {
  if (achievedOn === null) return null;
  const t = await getTranslations('objetivos');

  return (
    <Stack gap="xs" align="start">
      <Badge variant="outline">{t('achievedBadge')}</Badge>
      <Text as="span" size="xs" tone="muted">
        {t('achievedOnDate', { date: formatBusinessDate(achievedOn) })}
        {/* BR-019-26 — said explicitly, not left to be inferred from a badge
            that would otherwise look identical whether the goal still holds
            or not. */}
        {!currentlyAchieved && ` ${t('achievedSinceDipped')}`}
      </Text>
    </Stack>
  );
}
