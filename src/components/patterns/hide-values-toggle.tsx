'use client';

import { useFormStatus } from 'react-dom';
import { useTranslations } from 'next-intl';
import { Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';

type FormAction = (formData: FormData) => Promise<void>;

export interface HideValuesToggleProps {
  /** The account's `ui.hide_values`, as the server rendered this page with it. */
  readonly masked: boolean;
  readonly action: FormAction;
}

/**
 * SPEC-022 BR-022-24/25 — the eye toggle in the top bar.
 *
 * **A form, not client state.** Masking is applied by the server when it
 * renders (DL-022-06), so the toggle's whole job is to change the stored
 * preference and have the page rendered again; the action revalidates the
 * layout and the response arrives already masked or unmasked. Hiding amounts in
 * the browser instead would mean they were in the HTML to begin with, which is
 * what BR-022-25 forbids. It also works before hydration, like every other form
 * here (DS-37).
 *
 * The accessible name stays "Ocultar valores" and `aria-pressed` carries the
 * state, so a screen reader hears "Ocultar valores, pressionado" rather than a
 * label that flips between two commands.
 *
 * The action is a prop (DS-02); `authenticated-frame.tsx` wires the real one.
 */
export function HideValuesToggle({ masked, action }: HideValuesToggleProps) {
  return (
    <form action={action} data-slot="hide-values-form">
      <input type="hidden" name="hidden" value={String(!masked)} />
      <ToggleButton masked={masked} />
    </form>
  );
}

function ToggleButton({ masked }: { masked: boolean }) {
  const t = useTranslations('hideValues');
  const { pending } = useFormStatus();
  const Icon = masked ? EyeOff : Eye;

  return (
    <Button
      type="submit"
      variant="ghost"
      size="icon-lg"
      aria-pressed={masked}
      aria-label={t('toggle')}
      // Not `disabled`: a disabled button drops focus mid-submit, and keyboard
      // users would land on <body>.
      aria-disabled={pending || undefined}
      onClick={(event) => {
        if (pending) event.preventDefault();
      }}
      data-slot="hide-values-toggle"
    >
      <Icon aria-hidden="true" />
    </Button>
  );
}
