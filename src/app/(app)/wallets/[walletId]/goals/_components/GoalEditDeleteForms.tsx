import type { getTranslations } from 'next-intl/server';
import type { Money } from '@/core/shared/money';
import { updateGoalAction, deleteGoalAction } from '@/app/(app)/wallets/goal-actions';
import { ActionForm } from '@/components/patterns/action-form';
import { Field } from '@/components/patterns/field';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * SPEC-019 BR-019-03/27 — the one editable shape every goal shares: its name
 * and its amount. `kind`, `basis` and `period` are fixed at creation and have
 * no field here — `updateGoalAction` refuses a change to any of them, so a
 * form that never offers one cannot trigger that refusal by accident.
 *
 * Shared by both goal cards so an edit and a delete look and behave
 * identically regardless of kind.
 */
export function EditDeleteForms({
  goalId,
  walletId,
  name,
  amount,
  t,
}: {
  readonly goalId: string;
  readonly walletId: string;
  readonly name: string;
  readonly amount: Money;
  readonly t: Awaited<ReturnType<typeof getTranslations>>;
}) {
  return (
    <Stack gap="sm" align="start">
      <ActionForm action={updateGoalAction}>
        <input type="hidden" name="goalId" value={goalId} />
        <input type="hidden" name="walletId" value={walletId} />
        <Cluster gap="md" align="end">
          <Field id={`goal-name-${goalId}`} label={t('nameLabel')} width="lg">
            <Input name="name" defaultValue={name} required />
          </Field>
          <Field id={`goal-amount-${goalId}`} label={t('amountLabel')} width="md">
            {/*
              AR-09 — the stored amount, in full, never `toFixed(2)`.
              This form always submits this field, so any shortening here is a
              rounding decision that writes itself back into `NUMERIC(20,8)`:
              a goal created at 1000,125 would silently become 1000,13 the
              next time somebody renamed it. Display rounds; a form that
              round-trips a stored value does not.
            */}
            <Input name="amount" inputMode="decimal" defaultValue={amount.toString()} required />
          </Field>
          <Button type="submit">{t('save')}</Button>
        </Cluster>
      </ActionForm>
      <ActionForm action={deleteGoalAction}>
        <input type="hidden" name="goalId" value={goalId} />
        <input type="hidden" name="walletId" value={walletId} />
        <Button type="submit" variant="destructive" size="sm">
          {t('delete')}
        </Button>
      </ActionForm>
    </Stack>
  );
}
