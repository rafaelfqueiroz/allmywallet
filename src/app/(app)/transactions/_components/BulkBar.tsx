'use client';

import type { ReactNode } from 'react';
import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { IDLE, messageValues, type ActionState } from '@/app/(app)/transactions/action-state';
import { Field } from '@/components/patterns/field';
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
 * **One form wraps the whole table** rather than a toolbar that tracks
 * selection in React state. The row checkboxes are plain
 * `<input type="checkbox" name="selected">` inside this form, so the browser
 * collects the selection natively on submit — no hydration, no client state
 * that can disagree with what is on screen, and the operation is chosen
 * *after* the rows are, which is the order a user actually works in.
 *
 * The table is passed as `children` and stays a Server Component: it is
 * rendered on the server and handed through this boundary as an element, so
 * making the toolbar interactive does not drag ten thousand rows of table into
 * the client bundle.
 *
 * `useActionState` for the same reason as the entry form — a bulk delete can
 * be refused (BR-006-15: the selection would leave a ledger that cannot be
 * replayed) and the refusal has to explain itself.
 */

export interface WalletChoice {
  readonly walletId: string;
  readonly name: string;
}

export interface BulkBarProps {
  readonly action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  readonly wallets: readonly WalletChoice[];
  readonly children: ReactNode;
}

export function BulkBar({ action, wallets, children }: BulkBarProps) {
  const t = useTranslations('transactions.bulk');
  const tErrors = useTranslations('errors');
  const [state, formAction, pending] = useActionState(action, IDLE);

  return (
    <form action={formAction} aria-label={t('label')}>
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

        {children}

        <Cluster gap="md" align="end" role="group" aria-label={t('selection')}>
          <Button
            type="submit"
            name="operation"
            value="delete"
            variant="outline"
            disabled={pending}
          >
            {t('delete')}
          </Button>

          {wallets.length === 0 ? (
            <Note>{t('noWallets')}</Note>
          ) : (
            <>
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
              <Button type="submit" name="operation" value="assign" disabled={pending}>
                {t('assign')}
              </Button>
            </>
          )}
        </Cluster>

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
