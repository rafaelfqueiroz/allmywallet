import type { getTranslations } from 'next-intl/server';
import type { Money } from '@/core/shared/money';
import { updateGoalAction, deleteGoalAction } from '@/app/(app)/wallets/goal-actions';
import { saveHideValuesAction } from '@/app/(settings)/account/actions';
import { useHideValues } from '@/app/hide-values';
import { RevealValuesForm } from '@/components/patterns/reveal-values-form';
import { ActionForm } from '@/components/patterns/action-form';
import { Field } from '@/components/patterns/field';
import { FormActions, FormGrid } from '@/components/patterns/form-layout';
import { Stack } from '@/components/layout/stack';
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
 *
 * SPEC-022 BR-022-37 — the standard form's grid and footer, in the goal
 * panel's own footer: the goal's panel is the record being edited, so a second
 * panel for its two fields would repeat its title. Nome beside Valor, Excluir
 * meta alone at the left, Salvar at the right. Excluir posts its own form —
 * rendered after this one, since a form cannot hold another — through the
 * button's `form` attribute, which needs no JavaScript.
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
  // SPEC-022 BR-022-24: the amount field would put the goal in the HTML.
  const masked = useHideValues();
  const deleteFormId = `goal-delete-${goalId}`;
  const deleteButton = (
    <Button type="submit" form={deleteFormId} variant="destructive-outline">
      {t('delete')}
    </Button>
  );
  return (
    <Stack gap="sm">
      {masked ? (
        <Stack gap="sm">
          <RevealValuesForm action={saveHideValuesAction} />
          <FormActions destructive={deleteButton} />
        </Stack>
      ) : (
        <ActionForm action={updateGoalAction}>
          <input type="hidden" name="goalId" value={goalId} />
          <input type="hidden" name="walletId" value={walletId} />
          <Stack gap="md">
            <FormGrid>
              <Field id={`goal-name-${goalId}`} label={t('nameLabel')}>
                <Input name="name" defaultValue={name} required />
              </Field>
              <Field id={`goal-amount-${goalId}`} label={t('amountLabel')}>
                {/*
                AR-09 — the stored amount, in full, never `toFixed(2)`.
                This form always submits this field, so any shortening here is a
                rounding decision that writes itself back into `NUMERIC(20,8)`:
                a goal created at 1000,125 would silently become 1000,13 the
                next time somebody renamed it. Display rounds; a form that
                round-trips a stored value does not.
              */}
                <Input
                  name="amount"
                  inputMode="decimal"
                  defaultValue={amount.toString()}
                  required
                />
              </Field>
            </FormGrid>
            <FormActions
              destructive={deleteButton}
              cancel={
                <Button type="reset" variant="outline">
                  {t('cancel')}
                </Button>
              }
            >
              <Button type="submit">{t('save')}</Button>
            </FormActions>
          </Stack>
        </ActionForm>
      )}
      <ActionForm id={deleteFormId} action={deleteGoalAction}>
        <input type="hidden" name="goalId" value={goalId} />
        <input type="hidden" name="walletId" value={walletId} />
      </ActionForm>
    </Stack>
  );
}
