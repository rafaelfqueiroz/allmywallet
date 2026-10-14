'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { IDLE, messageValues, type ActionState } from '@/lib/action-state';
import { ErrorState } from '@/components/patterns/error-state';
import { FormPanel } from '@/components/patterns/form-layout';
import { Stack } from '@/components/layout/stack';

/**
 * A form whose server action can refuse, with the refusal on screen.
 *
 * **What this replaces.** The wallet actions ended `if (isErr(result)) return;`
 * — the domain refused, the action returned `void`, and the page re-rendered
 * unchanged. `action-state.ts` used to justify that: every wallet form was "an
 * assign-the-whole-thing click with nothing to explain". That was never quite
 * true and #63 pinned why. SPEC-010 AC-4 is "allocating more than the held
 * quantity is **refused at write time**" — a rule whose entire observable
 * behaviour is the refusal. A form that silently redisplays itself is
 * indistinguishable from one that worked, so the user's next move is to submit
 * again, and BR-010-05's whole purpose is invisible.
 *
 * Deliberately generic rather than one wrapper per form: these are plain
 * forms with a submit button, and the only thing they each need is somewhere
 * for `state.code` to render through the `errors.*` catalogue (AR-38). The
 * richer forms — `TransactionForm`, `BulkBar` — keep their own
 * `useActionState` because they also drive field-level state and a pending
 * label, which a wrapper this shape cannot express without becoming a render
 * prop for no gain.
 *
 * The error region is `Stack`ed *above* the fields on purpose: a refusal below
 * a submit button, on a form long enough to scroll, is a refusal the user never
 * sees.
 *
 * **`panel` makes it a create or edit form** (SPEC-022 BR-022-37): the form
 * wraps a `FormPanel` with that title, the refusal opens the panel's body, and
 * `panel.footer` — the form's `FormActions` — sits inside the form, so its
 * buttons submit it without JavaScript (DS-37). Without `panel` it is the bare
 * form a table row's button or a one-button delete needs.
 */
export function ActionForm({
  action,
  panel,
  children,
  ...rest
}: {
  readonly action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  readonly panel?: {
    readonly title: React.ReactNode;
    readonly description?: React.ReactNode;
    readonly footer?: React.ReactNode;
    readonly id?: string;
    readonly className?: string;
  };
  readonly children: React.ReactNode;
} & Omit<React.ComponentProps<'form'>, 'action' | 'children'>) {
  const tErrors = useTranslations('errors');
  const [state, formAction] = useActionState(action, IDLE);
  const alert = state.status === 'error' && (
    <ErrorState title={tErrors(state.code, messageValues(state.context))} />
  );

  if (panel !== undefined) {
    return (
      <form action={formAction} {...rest}>
        <FormPanel {...panel} alert={alert}>
          {children}
        </FormPanel>
      </form>
    );
  }

  return (
    <form action={formAction} {...rest}>
      <Stack gap="sm">
        {alert}
        {children}
      </Stack>
    </form>
  );
}
