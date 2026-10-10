import { useTranslations } from 'next-intl';
import { Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { Stack } from '@/components/layout/stack';

/**
 * SPEC-022 BR-022-24 — what an edit form becomes while amounts are hidden.
 *
 * A form that edits a stored amount would otherwise put that amount in its
 * input's `value`, in the HTML and on the screen. Rendering the input empty
 * does not work either: the form round-trips the stored value, so an empty
 * field would be submitted as a new one (AR-09's note on the goal form). So
 * the form is not offered at all: one sentence says why, and one button shows
 * the values — the same write as the eye toggle — after which the page renders
 * the form with its values.
 *
 * A `<form>`, so it works before hydration (DS-37). The action is a prop
 * (DS-02); pages pass `saveHideValuesAction`.
 */
export function RevealValuesForm({
  action,
}: {
  readonly action: (formData: FormData) => Promise<void>;
}) {
  const t = useTranslations('hideValues');
  return (
    <form action={action} data-slot="reveal-values-form">
      <input type="hidden" name="hidden" value="false" />
      <Stack gap="sm" align="start">
        <Text as="p" size="sm" tone="muted">
          {t('formHidden')}
        </Text>
        <Button type="submit" variant="outline" size="sm">
          <Eye aria-hidden="true" />
          {t('reveal')}
        </Button>
      </Stack>
    </form>
  );
}
