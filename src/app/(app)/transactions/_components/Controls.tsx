import { getTranslations } from 'next-intl/server';
import { TRANSACTION_STATUSES, TRANSACTION_TYPES } from '@/core/ledger/transaction';
import { PARAM } from '@/lib/transactions-url-state';
import {
  ASSET_CLASSES,
  type AssetOption,
  type InstitutionOption,
  type WalletChoice,
} from '@/app/(app)/transactions/data';
import { Field } from '@/components/patterns/field';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';

/**
 * SPEC-006 BR-006-08/09 — the transaction history's filter bar.
 *
 * Same shape as `(app)/reports/_components/Controls.tsx`: a plain
 * `<form method="get">`, so the view is bookmarkable and works before any
 * client JavaScript has loaded, and every field maps to exactly one URL
 * parameter (`lib/transactions-url-state.ts`) so no two parameters can
 * disagree about what is being asked — the failure SPEC-011's scope control
 * shipped with for a whole milestone.
 *
 * AR-44: every label comes from `next-intl`. Transaction-type and asset-class
 * labels are **not** re-translated here — they already exist as
 * `import.transactionType.*` and `reports.assetClass.*`, and duplicating them
 * would be two catalogues that can drift on the thirteenth type.
 */

export interface ControlsProps {
  readonly from: string;
  readonly to: string;
  readonly asset: string;
  readonly assetClass: string;
  readonly type: string;
  readonly institution: string;
  readonly status: string;
  readonly wallet: string;
  readonly search: string;
  readonly assetOptions: readonly AssetOption[];
  readonly institutionOptions: readonly InstitutionOption[];
  readonly walletOptions: readonly WalletChoice[];
}

export async function Controls({
  from,
  to,
  asset,
  assetClass,
  type,
  institution,
  status,
  wallet,
  search,
  assetOptions,
  institutionOptions,
  walletOptions,
}: ControlsProps) {
  const t = await getTranslations('transactions');
  const tType = await getTranslations('import.transactionType');
  const tAssetClass = await getTranslations('reports.assetClass');

  return (
    <form method="get" action="/transactions" aria-label={t('title')}>
      <Card>
        <CardContent>
          <Cluster gap="md" align="end">
            <Field id="transactions-from" label={t('filters.from')} width="sm">
              <Input type="date" name={PARAM.from} defaultValue={from} />
            </Field>
            <Field id="transactions-to" label={t('filters.to')} width="sm">
              <Input type="date" name={PARAM.to} defaultValue={to} />
            </Field>

            <Field id="transactions-search" label={t('filters.search')} width="md">
              <Input
                type="search"
                name={PARAM.q}
                defaultValue={search}
                placeholder={t('filters.searchPlaceholder')}
              />
            </Field>

            <Field id="transactions-asset" label={t('filters.asset')} width="lg">
              <NativeSelect name={PARAM.asset} defaultValue={asset}>
                <option value="">{t('filters.assetAll')}</option>
                {assetOptions.map((option) => (
                  <option key={option.assetId} value={option.assetId}>
                    {option.code} — {option.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>

            <Field id="transactions-asset-class" label={t('filters.assetClass')} width="md">
              <NativeSelect name={PARAM.assetClass} defaultValue={assetClass}>
                <option value="">{t('filters.assetClassAll')}</option>
                {ASSET_CLASSES.map((value) => (
                  <option key={value} value={value}>
                    {tAssetClass(value)}
                  </option>
                ))}
              </NativeSelect>
            </Field>

            <Field id="transactions-type" label={t('filters.type')} width="md">
              <NativeSelect name={PARAM.type} defaultValue={type}>
                <option value="">{t('filters.typeAll')}</option>
                {TRANSACTION_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {tType(value)}
                  </option>
                ))}
              </NativeSelect>
            </Field>

            <Field id="transactions-institution" label={t('filters.institution')} width="md">
              <NativeSelect name={PARAM.institution} defaultValue={institution}>
                <option value="">{t('filters.institutionAll')}</option>
                {institutionOptions.map((option) => (
                  <option key={option.institutionId} value={option.institutionId}>
                    {option.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>

            {/* BR-006-03: `unclassified` and `superseded` must be
                distinguishable rather than hidden — the default (no filter)
                shows all three statuses, and this narrows to one. */}
            <Field id="transactions-status" label={t('filters.status')} width="md">
              <NativeSelect name={PARAM.status} defaultValue={status}>
                <option value="">{t('filters.statusAll')}</option>
                {TRANSACTION_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {t(`status.${value}`)}
                  </option>
                ))}
              </NativeSelect>
            </Field>

            {/*
              BR-006-08's wallet dimension. Hidden entirely when the tenant has
              no wallets: a control whose only option is "all" asks a question
              with one answer, and on this surface it would also imply that
              transactions can belong to a wallet before any wallet exists.

              The hint is not decoration. A transaction has no wallet and
              cannot have one (`core/ledger/ports.ts` explains why), so this
              narrows to the *assets a wallet holds today* — which means the
              same filter over the same ledger returns different rows after a
              reallocation. Saying so on the control is cheaper than a user
              discovering it and concluding the history changed.
            */}
            {walletOptions.length > 0 && (
              <Field
                id="transactions-wallet"
                label={t('filters.wallet')}
                hint={t('filters.walletHint')}
                width="md"
              >
                <NativeSelect name={PARAM.wallet} defaultValue={wallet}>
                  <option value="">{t('filters.walletAll')}</option>
                  {walletOptions.map((option) => (
                    <option key={option.walletId} value={option.walletId}>
                      {option.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            )}

            <Button type="submit">{t('filters.apply')}</Button>
          </Cluster>
        </CardContent>
      </Card>
    </form>
  );
}
