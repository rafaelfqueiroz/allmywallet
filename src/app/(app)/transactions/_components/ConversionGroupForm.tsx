'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ActionState } from '@/lib/action-state';
import { IDLE, messageValues } from '@/lib/action-state';
import { ErrorState } from '@/components/patterns/error-state';
import { Field } from '@/components/patterns/field';
import { FormActions, FormGrid, FormPanel } from '@/components/patterns/form-layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface ConversionGroupFormLeg {
  readonly id: string;
  readonly assetId: string;
  /** The asset's code, for the leg's heading. The id is not something a person reads. */
  readonly assetCode: string;
  readonly type: 'conversion_out' | 'conversion_in';
  /** The leg's date, formatted by the page. */
  readonly date: string;
  readonly quantity: string;
  readonly costBasis: string;
}

interface ConversionGroupFormProps {
  readonly action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  readonly conversionGroupId: string;
  readonly legs: readonly ConversionGroupFormLeg[];
}

/**
 * SPEC-006 BR-006-05: one form submission always replaces the complete group.
 *
 * SPEC-022 BR-022-20: each leg is a named group — its type, asset and date
 * — with its two figures side by side in a grid, as `Field`s, so the pair has
 * one height and each figure its own accessible name. The rule that binds the
 * legs is the panel's description.
 */
export function ConversionGroupForm({ action, conversionGroupId, legs }: ConversionGroupFormProps) {
  const t = useTranslations('transactions.conversionGroup');
  const tType = useTranslations('import.transactionType');
  const tErrors = useTranslations('errors');
  const [state, formAction, pending] = useActionState(action, IDLE);

  return (
    <form action={formAction}>
      {/* SPEC-022 BR-022-37 — the standard form: one panel, each leg a group of
          two fields side by side, Cancelar then Salvar at the footer's right. */}
      <FormPanel
        title={t('panelTitle')}
        description={t('hint')}
        alert={
          state.status === 'error' ? (
            <ErrorState title={tErrors(state.code, messageValues(state.context))} />
          ) : undefined
        }
        footer={
          <FormActions
            cancel={
              <Button asChild variant="outline">
                <Link href="/transactions">{t('cancel')}</Link>
              </Button>
            }
          >
            <Button type="submit" disabled={pending}>
              {pending ? t('submitting') : t('submit')}
            </Button>
          </FormActions>
        }
      >
        <input type="hidden" name="conversionGroupId" value={conversionGroupId} />
        {legs.map((leg, index) => (
          <FormGrid
            key={leg.id}
            legend={t('leg', { index: index + 1, type: tType(leg.type), asset: leg.assetCode })}
            description={leg.date}
          >
            <input type="hidden" name="legId" value={leg.id} />
            <Field id={`quantity-${leg.id}`} label={t('quantity')}>
              <Input name="quantity" inputMode="decimal" required defaultValue={leg.quantity} />
            </Field>
            <Field id={`cost-${leg.id}`} label={t('costBasis')}>
              <Input name="costBasis" inputMode="decimal" required defaultValue={leg.costBasis} />
            </Field>
          </FormGrid>
        ))}
      </FormPanel>
    </form>
  );
}
