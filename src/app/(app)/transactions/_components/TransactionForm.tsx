'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { TRANSACTION_TYPES } from '@/core/ledger/transaction';
import { IDLE, messageValues, type ActionState } from '@/lib/action-state';
import { Field } from '@/components/patterns/field';
import { ErrorState } from '@/components/patterns/error-state';
import { Section } from '@/components/patterns/section';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';

/**
 * SPEC-006 BR-006-11/12 — manual entry and correction, one form for both.
 *
 * **A Client Component, unlike every other form on this surface.** The filter
 * bar and the pagination are `<form method="get">` because they only ask for a
 * different view; this one refuses input, and BR-006-15 requires the refusal
 * to say why. `useActionState` is what carries the domain's code and context
 * back to the field the user is looking at — see `action-state.ts` for why a
 * `void` action (the shape `(app)/wallets/actions.ts` uses) cannot.
 *
 * It still submits without JavaScript: React binds a Server Action to the
 * form's native POST, so the browser posts, the server runs the action and
 * re-renders with the returned state. Nothing below depends on hydration
 * having happened — the same reason every control here is native.
 *
 * AR-44: every string comes from `next-intl`. Type labels are reused from
 * `import.transactionType.*` and asset classes from `reports.assetClass.*`
 * rather than duplicated, so the thirteenth type cannot exist in one
 * catalogue and not the other.
 */

/**
 * The option shapes are declared here, structurally, rather than imported from
 * `data.ts`. This is a Client Component, and `data.ts` imports `@/db/client` —
 * so a *value* import of its `ASSET_CLASSES` re-export pulls `pg` into the
 * browser bundle, which fails the build with `Can't resolve 'util/types'`
 * rather than with anything that mentions a boundary. `Controls.tsx` may
 * import the same module because it is a Server Component; this one may not,
 * and structural props are what keep that true by construction.
 */
export interface AssetChoice {
  readonly assetId: string;
  readonly code: string;
  readonly name: string;
}

export interface InstitutionChoice {
  readonly institutionId: string;
  readonly name: string;
}

export interface TransactionFormValues {
  readonly transactionId?: string;
  readonly assetId: string;
  readonly institutionId: string;
  readonly type: string;
  readonly tradeDate: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly fees: string;
  readonly ratio: string;
}

export interface TransactionFormProps {
  readonly action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  readonly mode: 'create' | 'edit';
  readonly values: TransactionFormValues;
  readonly assetOptions: readonly AssetChoice[];
  readonly institutionOptions: readonly InstitutionChoice[];
  /** Passed in for the same reason the types are declared here. */
  readonly assetClasses: readonly string[];
}

export function TransactionForm({
  action,
  mode,
  values,
  assetOptions,
  institutionOptions,
  assetClasses,
}: TransactionFormProps) {
  const t = useTranslations('transactions.form');
  const tErrors = useTranslations('errors');
  const tType = useTranslations('import.transactionType');
  const tAssetClass = useTranslations('reports.assetClass');
  const [state, formAction, pending] = useActionState(action, IDLE);

  return (
    <form action={formAction}>
      <Stack gap="lg">
        {state.status === 'error' && (
          /**
           * AR-38: the domain returned a code and a context; the catalogue
           * turns them into pt-BR. `INSUFFICIENT_QUANTITY` is the one that
           * makes BR-006-15 true — its message names the quantity held on the
           * date, which is the whole difference between an explanation and a
           * rejection.
           */
          <ErrorState title={tErrors(state.code, messageValues(state.context))} />
        )}

        {values.transactionId !== undefined && (
          <input type="hidden" name="transactionId" value={values.transactionId} />
        )}

        <Section title={t('assetSection')}>
          <Cluster gap="md" align="end">
            <Field id="transaction-asset" label={t('assetExisting')} width="lg">
              <NativeSelect name="assetId" defaultValue={values.assetId}>
                <option value="">{t('assetExistingNone')}</option>
                {assetOptions.map((option) => (
                  <option key={option.assetId} value={option.assetId}>
                    {option.code} — {option.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>

            {/*
              The spec's "a CDB absent from every B3 extract" criterion. The
              catalogue only ever contains what an extract or a quote sync put
              there, so an instrument nobody has imported has to be nameable
              here or it cannot enter the product at all. `actions.ts` resolves
              this through the same `DrizzleAssetResolver` the import commit
              uses, so a manually entered PETR4 and an imported one are one row.
            */}
            <Field
              id="transaction-asset-code"
              label={t('assetNewCode')}
              hint={t('assetNewCodeHint')}
              width="md"
            >
              <Input name="assetCode" autoComplete="off" />
            </Field>
            <Field id="transaction-asset-name" label={t('assetNewName')} width="lg">
              <Input name="assetName" autoComplete="off" />
            </Field>
            <Field id="transaction-asset-class" label={t('assetNewClass')} width="md">
              <NativeSelect name="assetClass" defaultValue="stock">
                {assetClasses.map((value) => (
                  <option key={value} value={value}>
                    {tAssetClass(value)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </Cluster>
        </Section>

        <Section title={t('institutionSection')}>
          <Cluster gap="md" align="end">
            <Field id="transaction-institution" label={t('institutionExisting')} width="lg">
              <NativeSelect name="institutionId" defaultValue={values.institutionId}>
                {/* BR-007-08: no institution is a real, distinct bucket — an
                    asset held directly — not "any institution". */}
                <option value="">{t('institutionExistingNone')}</option>
                {institutionOptions.map((option) => (
                  <option key={option.institutionId} value={option.institutionId}>
                    {option.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id="transaction-institution-name" label={t('institutionNew')} width="lg">
              <Input name="institutionName" autoComplete="off" />
            </Field>
          </Cluster>
        </Section>

        <Section title={t('detailsSection')}>
          <Cluster gap="md" align="end">
            {/* BR-006-05: all thirteen, and no others. */}
            <Field id="transaction-type" label={t('type')} width="md">
              <NativeSelect name="type" defaultValue={values.type} required>
                {TRANSACTION_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {tType(value)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id="transaction-date" label={t('tradeDate')} width="md">
              <Input type="date" name="tradeDate" defaultValue={values.tradeDate} required />
            </Field>

            {/*
              `inputMode="decimal"` on a text field rather than
              `type="number"`: a pt-BR keyboard produces `32,15`, which a
              number input refuses to submit at all. `lib/decimal-input.ts`
              reads both forms, and AR-06 keeps the value a string the whole
              way to `Money`/`Quantity`.
            */}
            <Field id="transaction-quantity" label={t('quantity')} width="md">
              <Input name="quantity" inputMode="decimal" defaultValue={values.quantity} required />
            </Field>
            <Field id="transaction-price" label={t('unitPrice')} hint={t('decimalHint')} width="md">
              <Input
                name="unitPrice"
                inputMode="decimal"
                defaultValue={values.unitPrice}
                required
              />
            </Field>
            <Field id="transaction-fees" label={t('fees')} width="md">
              <Input name="fees" inputMode="decimal" defaultValue={values.fees} />
            </Field>
            {/* SPEC-007 BR-007-04 — split and grupamento only. */}
            <Field id="transaction-ratio" label={t('ratio')} hint={t('ratioHint')} width="md">
              <Input name="ratio" inputMode="decimal" defaultValue={values.ratio} />
            </Field>
          </Cluster>
        </Section>

        <Cluster gap="sm">
          <Button type="submit" disabled={pending}>
            {pending ? t('submitting') : t(mode === 'create' ? 'submitCreate' : 'submitEdit')}
          </Button>
          <Button asChild variant="outline">
            <Link href="/transactions">{t('cancel')}</Link>
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
