'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { IDLE, messageValues, type ActionState } from '@/app/(app)/transactions/action-state';
import { ErrorState } from '@/components/patterns/error-state';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';

/**
 * SPEC-006 BR-006-13's confirmation, once the impact above it has been read.
 *
 * A Client Component only because the refusal has to be shown: deleting the
 * buy a later sale drew on leaves a ledger that cannot be replayed, and
 * `describeDeletionImpact` catches that *before* the confirmation renders —
 * but the ledger can change between the page load and the click, so the write
 * refuses too and that refusal needs somewhere to land.
 */
export interface DeleteConfirmProps {
  readonly action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  readonly transactionId: string;
}

export function DeleteConfirm({ action, transactionId }: DeleteConfirmProps) {
  const t = useTranslations('transactions.delete');
  const tErrors = useTranslations('errors');
  const [state, formAction, pending] = useActionState(action, IDLE);

  return (
    <form action={formAction}>
      <Stack gap="md">
        {state.status === 'error' && (
          <ErrorState title={tErrors(state.code, messageValues(state.context))} />
        )}
        <input type="hidden" name="transactionId" value={transactionId} />
        <Cluster gap="sm">
          <Button type="submit" variant="destructive" disabled={pending}>
            {t('confirm')}
          </Button>
          <Button asChild variant="outline">
            <Link href="/transactions">{t('cancel')}</Link>
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
