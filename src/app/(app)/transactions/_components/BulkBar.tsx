'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { IDLE, messageValues, type ActionState } from '@/lib/action-state';
import { Field, FieldAction } from '@/components/patterns/field';
import { ErrorState } from '@/components/patterns/error-state';
import { Note } from '@/components/patterns/note';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';

/**
 * SPEC-006 BR-006-17 — "bulk operations: delete multiple, assign multiple to
 * a wallet", over the multi-selection the table itself carries.
 *
 * **The selection is native**, not React state. The row checkboxes are plain
 * `<input type="checkbox" name="selected" form="transactions-bulk">`, owned by
 * this form through the `form` attribute, so the browser collects the
 * selection on submit — no hydration, no client state that can disagree with
 * what is on screen, and the operation is chosen *after* the rows are, which
 * is the order a user actually works in.
 *
 * The attribute rather than a wrapping form (as this was before SPEC-022):
 * the table now carries its filter bar, a GET form of its own, and forms do
 * not nest.
 *
 * `useActionState` for the same reason as the entry form — a bulk delete can
 * be refused (BR-006-15: the selection would leave a ledger that cannot be
 * replayed) and the refusal has to explain itself.
 */

export interface WalletChoice {
  readonly walletId: string;
  readonly name: string;
}

/** The id every row checkbox names in its `form` attribute. */
export const BULK_FORM_ID = 'transactions-bulk';

export interface BulkBarProps {
  readonly action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  readonly wallets: readonly WalletChoice[];
}

export function BulkBar({ action, wallets }: BulkBarProps) {
  const t = useTranslations('transactions.bulk');
  const tErrors = useTranslations('errors');
  const [state, formAction, pending] = useActionState(action, IDLE);
  const deleteButton = (
    <Button type="submit" name="operation" value="delete" variant="outline" disabled={pending}>
      {t('delete')}
    </Button>
  );

  return (
    <form id={BULK_FORM_ID} action={formAction} aria-label={t('label')}>
      <Stack gap="md">
        {state.status === 'error' && (
          <ErrorState title={tErrors(state.code, messageValues(state.context))} />
        )}

        {/*
          `role="status"`, not `alert`: this is the result of something the
          user just asked for, not an interruption. It is also the only place
          the clamp becomes visible — `assignTransactionsToWallet` reduces a
          request to what is actually unassigned, and a clamp nobody is told
          about is a silent change to what was asked for.
        */}
        {state.status === 'deleted' && <Note role="status">{t('deleted', state)}</Note>}
        {state.status === 'assigned' && (
          <Note role="status">
            {state.assigned === 0
              ? t('assignedNone')
              : state.skipped === 0
                ? t('assigned', state)
                : t('assignedPartial', state)}
          </Note>
        )}

        {/* Fields align from the top, buttons through `FieldAction`, so the
            row has one height (SPEC-022 BR-022-20). */}
        <Cluster gap="md" align="start" role="group" aria-label={t('selection')}>
          {/* With a wallet select in the row, the buttons line up with its
              input through `FieldAction`; alone, the button needs no label row. */}
          {wallets.length === 0 ? (
            deleteButton
          ) : (
            <>
              <FieldAction>{deleteButton}</FieldAction>
              <Field id="bulk-wallet" label={t('wallet')} width="lg">
                <NativeSelect name="walletId" defaultValue="">
                  <option value="">{t('walletNone')}</option>
                  {wallets.map((wallet) => (
                    <option key={wallet.walletId} value={wallet.walletId}>
                      {wallet.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <FieldAction>
                <Button type="submit" name="operation" value="assign" disabled={pending}>
                  {t('assign')}
                </Button>
              </FieldAction>
            </>
          )}
        </Cluster>

        {wallets.length === 0 && <Note>{t('noWallets')}</Note>}

        {/*
          BR-006-17's all-or-nothing property, said out loud. `bulk-delete-
          transactions.ts` groups the selection by position and replays each
          one with the *whole* selection removed before deleting anything,
          precisely so "undo this pair of duplicates" — legal together, illegal
          one at a time — is not refused.
        */}
        <Note>{t('hint')}</Note>
      </Stack>
    </form>
  );
}
