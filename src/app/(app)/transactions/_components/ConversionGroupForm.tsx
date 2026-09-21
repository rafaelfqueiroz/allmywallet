'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ActionState } from '@/lib/action-state';
import { IDLE, messageValues } from '@/lib/action-state';
import { ErrorState } from '@/components/patterns/error-state';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Text } from '@/components/ui/text';

export interface ConversionGroupFormLeg {
  readonly id: string;
  readonly assetId: string;
  readonly type: 'conversion_out' | 'conversion_in';
  readonly tradeDate: string;
  readonly quantity: string;
  readonly costBasis: string;
}

interface ConversionGroupFormProps {
  readonly action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  readonly conversionGroupId: string;
  readonly legs: readonly ConversionGroupFormLeg[];
}

/** SPEC-006 BR-006-05: one form submission always replaces the complete group. */
export function ConversionGroupForm({ action, conversionGroupId, legs }: ConversionGroupFormProps) {
  const t = useTranslations('transactions.conversionGroup');
  const tType = useTranslations('import.transactionType');
  const tErrors = useTranslations('errors');
  const [state, formAction, pending] = useActionState(action, IDLE);

  return (
    <form action={formAction}>
      <Stack gap="lg">
        {state.status === 'error' && (
          <ErrorState title={tErrors(state.code, messageValues(state.context))} />
        )}
        <input type="hidden" name="conversionGroupId" value={conversionGroupId} />
        <Text tone="muted">{t('hint')}</Text>
        {legs.map((leg, index) => (
          <Stack key={leg.id} gap="sm">
            <input type="hidden" name="legId" value={leg.id} />
            <Text weight="medium">
              {t('leg', { index: index + 1, type: tType(leg.type), assetId: leg.assetId })}
            </Text>
            <Text size="sm" tone="muted">
              {leg.tradeDate}
            </Text>
            <Label htmlFor={`quantity-${leg.id}`}>{t('quantity')}</Label>
            <Input
              id={`quantity-${leg.id}`}
              name="quantity"
              inputMode="decimal"
              required
              defaultValue={leg.quantity}
            />
            <Label htmlFor={`cost-${leg.id}`}>{t('costBasis')}</Label>
            <Input
              id={`cost-${leg.id}`}
              name="costBasis"
              inputMode="decimal"
              required
              defaultValue={leg.costBasis}
            />
          </Stack>
        ))}
        <Cluster gap="sm">
          <Button type="submit" disabled={pending}>
            {pending ? t('submitting') : t('submit')}
          </Button>
          <Button asChild variant="outline">
            <Link href="/transactions">{t('cancel')}</Link>
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
