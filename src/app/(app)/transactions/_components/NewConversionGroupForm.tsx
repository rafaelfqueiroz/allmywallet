'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ActionState } from '@/lib/action-state';
import { IDLE, messageValues } from '@/lib/action-state';
import type {
  AssetChoice,
  InstitutionChoice,
} from '@/app/(app)/transactions/_components/TransactionForm';
import { ErrorState } from '@/components/patterns/error-state';
import { Field } from '@/components/patterns/field';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';

interface NewConversionGroupFormProps {
  readonly action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  readonly assets: readonly AssetChoice[];
  readonly institutions: readonly InstitutionChoice[];
}

export function NewConversionGroupForm({
  action,
  assets,
  institutions,
}: NewConversionGroupFormProps) {
  const t = useTranslations('transactions.conversionGroup');
  const tErrors = useTranslations('errors');
  const [state, formAction, pending] = useActionState(action, IDLE);
  return (
    <form action={formAction}>
      <Stack gap="lg">
        {state.status === 'error' && (
          <ErrorState title={tErrors(state.code, messageValues(state.context))} />
        )}
        <Field id="conversion-source" label={t('sourceAsset')}>
          <NativeSelect id="conversion-source" name="sourceAssetId" required defaultValue="">
            <option value="" disabled>
              {t('chooseAsset')}
            </option>
            {assets.map((asset) => (
              <option key={asset.assetId} value={asset.assetId}>
                {asset.code} · {asset.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="conversion-target" label={t('targetAsset')}>
          <NativeSelect id="conversion-target" name="targetAssetId" required defaultValue="">
            <option value="" disabled>
              {t('chooseAsset')}
            </option>
            {assets.map((asset) => (
              <option key={asset.assetId} value={asset.assetId}>
                {asset.code} · {asset.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="conversion-institution" label={t('institution')}>
          <NativeSelect id="conversion-institution" name="institutionId" defaultValue="">
            <option value="">{t('noInstitution')}</option>
            {institutions.map((institution) => (
              <option key={institution.institutionId} value={institution.institutionId}>
                {institution.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="conversion-date" label={t('date')}>
          <Input id="conversion-date" name="tradeDate" type="date" required />
        </Field>
        <Field id="conversion-source-quantity" label={t('sourceQuantity')}>
          <Input
            id="conversion-source-quantity"
            name="sourceQuantity"
            inputMode="decimal"
            required
          />
        </Field>
        <Field id="conversion-target-quantity" label={t('targetQuantity')}>
          <Input
            id="conversion-target-quantity"
            name="targetQuantity"
            inputMode="decimal"
            required
          />
        </Field>
        <Field id="conversion-cost" label={t('costBasis')}>
          <Input id="conversion-cost" name="costBasis" inputMode="decimal" required />
        </Field>
        <Cluster gap="sm">
          <Button type="submit" disabled={pending}>
            {pending ? t('submitting') : t('submitCreate')}
          </Button>
          <Button asChild variant="outline">
            <Link href="/transactions">{t('cancel')}</Link>
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
