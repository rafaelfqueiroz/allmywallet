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
import { Section } from '@/components/patterns/section';
import { Grid } from '@/components/layout/grid';
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

/**
 * SPEC-006 BR-006-05 — a new asset conversion: both legs are written together.
 *
 * SPEC-022 BR-022-20: two titled sections in a grid — which assets, then how
 * much — so each row of fields has one height, and the cost's instructions sit
 * behind its info icon.
 */
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
        <Section title={t('assetsSection')}>
          <Grid cols={4}>
            <Field id="conversion-source" label={t('sourceAsset')} width="full">
              <NativeSelect name="sourceAssetId" required defaultValue="">
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
            <Field id="conversion-target" label={t('targetAsset')} width="full">
              <NativeSelect name="targetAssetId" required defaultValue="">
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
            <Field id="conversion-institution" label={t('institution')} width="full">
              <NativeSelect name="institutionId" defaultValue="">
                <option value="">{t('noInstitution')}</option>
                {institutions.map((institution) => (
                  <option key={institution.institutionId} value={institution.institutionId}>
                    {institution.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id="conversion-date" label={t('date')} width="full">
              <Input name="tradeDate" type="date" required />
            </Field>
          </Grid>
        </Section>
        <Section title={t('quantitiesSection')}>
          <Grid cols={4}>
            <Field id="conversion-source-quantity" label={t('sourceQuantity')} width="full">
              <Input name="sourceQuantity" inputMode="decimal" required />
            </Field>
            <Field id="conversion-target-quantity" label={t('targetQuantity')} width="full">
              <Input name="targetQuantity" inputMode="decimal" required />
            </Field>
            <Field
              id="conversion-cost"
              label={t('costBasis')}
              hint={t('costBasisHint')}
              width="full"
            >
              <Input name="costBasis" inputMode="decimal" required />
            </Field>
          </Grid>
        </Section>
        <Cluster gap="sm" justify="end">
          <Button asChild variant="outline">
            <Link href="/transactions">{t('cancel')}</Link>
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? t('submitting') : t('submitCreate')}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
