import { getTranslations } from 'next-intl/server';
import type { ActionState } from '@/lib/action-state';
import { FIXED_INCOME_INDEXERS, type FixedIncomeIndexer } from '@/core/valuation/ports';
import type { AssetId } from '@/core/shared/ids';
import { ActionForm } from '@/components/patterns/action-form';
import { Field } from '@/components/patterns/field';
import { Cluster } from '@/components/layout/cluster';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Button } from '@/components/ui/button';

/**
 * SPEC-020 BR-020-19 / SPEC-009 BR-009-13 — the form that resolves a missing
 * fixed-income rate: the indexer B3's extract could not carry, and the
 * contracted rate as a percentage (`FixedIncomeContract.ratePercent`'s own
 * convention — "110" for 110% of CDI, "6" for IPCA + 6% a.a., never a
 * fraction).
 *
 * A Server Component: the only client behaviour this needs is `ActionForm`'s
 * refusal rendering, which already posts without JavaScript through the
 * form's native submission (`RuleForm`/`GoalEditDeleteForms` are the same
 * shape).
 */
export async function ContractTermsForm({
  assetId,
  indexer,
  ratePercent,
  action,
}: {
  readonly assetId: AssetId;
  readonly indexer: FixedIncomeIndexer | null;
  readonly ratePercent: string | null;
  readonly action: (state: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const t = await getTranslations('fixedIncome');

  return (
    <ActionForm action={action}>
      <input type="hidden" name="assetId" value={assetId} />
      <Cluster gap="md" align="end">
        <Field id="contract-indexer" label={t('indexerLabel')} width="md">
          <NativeSelect name="indexer" defaultValue={indexer ?? ''} required>
            <option value="">—</option>
            {FIXED_INCOME_INDEXERS.map((value) => (
              <option key={value} value={value}>
                {t(`indexerOptions.${value}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="contract-rate" label={t('rateLabel')} hint={t('rateHint')} width="sm">
          <Input
            name="ratePercent"
            inputMode="decimal"
            defaultValue={ratePercent ?? ''}
            required
          />
        </Field>
      </Cluster>
      <Cluster>
        <Button type="submit">{t('submit')}</Button>
      </Cluster>
    </ActionForm>
  );
}
