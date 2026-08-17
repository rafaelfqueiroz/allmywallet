import { getTranslations } from 'next-intl/server';
import { Note } from '@/components/patterns/note';
import { Stack } from '@/components/layout/stack';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';

/**
 * SPEC-005 BR-005-28 — the refresh prompt, when the last custody import is
 * older than `import.staleness_days`.
 *
 * **Non-blocking, and that is a rule rather than a style choice.** Stale
 * custody data does not make the app wrong; it makes it answer a question
 * about an earlier date, which BR-005-27's two dates already state on every
 * screen showing portfolio value. A modal here would interrupt someone
 * checking a figure they know is a month old, every single time, to tell them
 * something they know. So: a note in the flow, dismissible by ignoring it.
 *
 * **It carries the steps, not just the nag.** A prompt that says "your data is
 * old" and stops has moved the work to the user without helping them do it —
 * the whole reason DL-005-01 accepted manual friction is that the friction
 * would be mitigated by UX.
 */
export async function StalenessPrompt({
  daysSinceImport,
  thresholdDays,
}: {
  /** `null` when the user has never imported. */
  readonly daysSinceImport: number | null;
  readonly thresholdDays: number;
}) {
  const t = await getTranslations('import.staleness');

  return (
    <Note>
      <Stack gap="sm">
        <Text weight="medium">
          {daysSinceImport === null ? t('neverTitle') : t('staleTitle', { days: daysSinceImport })}
        </Text>
        <Text size="sm" tone="muted">
          {t('body', { threshold: thresholdDays })}
        </Text>
        <div>
          <Button asChild variant="link" size="sm">
            <a href="#import-guide">{t('seeSteps')}</a>
          </Button>
        </div>
      </Stack>
    </Note>
  );
}
