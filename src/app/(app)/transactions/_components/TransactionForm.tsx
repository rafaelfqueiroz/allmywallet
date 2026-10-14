'use client';

import { useActionState, useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { USER_EDITABLE_TRANSACTION_TYPES } from '@/core/ledger/transaction';
import { LedgerErrorCode } from '@/core/ledger/errors';
import { IDLE, messageValues, type ActionState } from '@/lib/action-state';
import { SharedErrorCode } from '@/core/shared/domain-error';
import { Field } from '@/components/patterns/field';
import { ErrorState } from '@/components/patterns/error-state';
import { FormActions, FormGrid, FormPanel } from '@/components/patterns/form-layout';
import { Stack } from '@/components/layout/stack';
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
 * SPEC-022 BR-022-20/21: instructions sit behind each field's info icon, the
 * fields sit in a grid so every row has one height, and a refusal that is
 * about one field (`FIELD_ERRORS`) renders under that field rather than in a
 * banner above the form. A refusal about the transaction as a whole — selling
 * more than was held — stays in the banner: no single field is wrong.
 *
 * **The user's typing survives a refusal.** React resets an uncontrolled form
 * once its action finishes; the values that were posted are kept and the
 * fields re-mounted with them as defaults (the WalletForm pattern, #210), so a
 * refused sale does not empty eight fields to say one of them was wrong.
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
  readonly soldFromWallet?: string;
  /** A new asset's code, name and class, and a new institution — blank by default. */
  readonly assetCode?: string;
  readonly assetName?: string;
  readonly assetClass?: string;
  readonly institutionName?: string;
}

type ErrorField = 'tradeDate' | 'quantity' | 'unitPrice' | 'fees' | 'ratio';

/** Each field a refusal can name, and its control's id — for the error and for focus. */
const FIELD_IDS: Readonly<Record<ErrorField, string>> = {
  tradeDate: 'transaction-date',
  quantity: 'transaction-quantity',
  unitPrice: 'transaction-price',
  fees: 'transaction-fees',
  ratio: 'transaction-ratio',
};

function isErrorField(value: unknown): value is ErrorField {
  return typeof value === 'string' && Object.hasOwn(FIELD_IDS, value);
}

/**
 * BR-022-21 — the domain refusals that are about one field, and the field.
 * Anything absent here is about the transaction as a whole and stays in the
 * banner.
 */
export const FIELD_ERRORS: Readonly<Record<string, ErrorField>> = {
  [LedgerErrorCode.FUTURE_TRADE_DATE]: 'tradeDate',
  [LedgerErrorCode.INVALID_QUANTITY]: 'quantity',
  [LedgerErrorCode.NEGATIVE_UNIT_PRICE]: 'unitPrice',
  [LedgerErrorCode.NEGATIVE_FEES]: 'fees',
  [LedgerErrorCode.RATIO_REQUIRED]: 'ratio',
  [LedgerErrorCode.RATIO_NOT_APPLICABLE]: 'ratio',
  [LedgerErrorCode.INVALID_RATIO]: 'ratio',
};

/** The posted values, as the next render's defaults. */
function posted(formData: FormData, previous: TransactionFormValues): TransactionFormValues {
  const text = (name: string) => String(formData.get(name) ?? '');
  return {
    ...previous,
    assetId: text('assetId'),
    assetCode: text('assetCode'),
    assetName: text('assetName'),
    assetClass: text('assetClass'),
    institutionId: text('institutionId'),
    institutionName: text('institutionName'),
    type: text('type'),
    tradeDate: text('tradeDate'),
    quantity: text('quantity'),
    unitPrice: text('unitPrice'),
    fees: text('fees'),
    ratio: text('ratio'),
    soldFromWallet: text('soldFromWallet'),
  };
}

export interface WalletChoiceView {
  readonly walletId: string;
  readonly name: string;
}

export interface TransactionFormProps {
  readonly action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  readonly mode: 'create' | 'edit';
  readonly values: TransactionFormValues;
  readonly assetOptions: readonly AssetChoice[];
  readonly institutionOptions: readonly InstitutionChoice[];
  /** Passed in for the same reason the types are declared here. */
  readonly assetClasses: readonly string[];
  /** SPEC-010 AC-010-15 — the tenant's wallets, for "which wallet sold". */
  readonly walletOptions: readonly WalletChoiceView[];
}

export function TransactionForm({
  action,
  mode,
  values,
  assetOptions,
  institutionOptions,
  assetClasses,
  walletOptions,
}: TransactionFormProps) {
  const t = useTranslations('transactions.form');
  const tErrors = useTranslations('errors');
  const tType = useTranslations('import.transactionType');
  const tAssetClass = useTranslations('reports.assetClass');
  // The server action goes to the hook as is (DS-37): a wrapping closure has
  // no `$$FORM_ACTION`, and the form would not post without JavaScript.
  const [state, formAction, pending] = useActionState(action, IDLE);
  const [draft, setDraft] = useState(values);
  const [submissions, setSubmissions] = useState(0);
  const remember = (event: FormEvent<HTMLFormElement>) => {
    const formData = new FormData(event.currentTarget);
    setDraft((previous) => posted(formData, previous));
    setSubmissions((count) => count + 1);
  };

  const refusal = state.status === 'error' ? state : null;
  /**
   * AR-38: the domain returned a code and a context; the catalogue turns them
   * into pt-BR. `INSUFFICIENT_QUANTITY` is the one that makes BR-006-15 true —
   * its message names the quantity held on the date, which is the whole
   * difference between an explanation and a rejection.
   */
  // A value the action could not read names its field in the context
  // (`invalidField`); a domain refusal is mapped by its code.
  const unreadable =
    refusal?.code === SharedErrorCode.VALIDATION_FAILED && isErrorField(refusal.context.field)
      ? refusal.context.field
      : undefined;
  const errorField = unreadable ?? (refusal ? FIELD_ERRORS[refusal.code] : undefined);
  const message =
    unreadable !== undefined
      ? t(unreadable === 'tradeDate' ? 'invalidDate' : 'invalidDecimal')
      : refusal
        ? tErrors(refusal.code, messageValues(refusal.context))
        : undefined;
  const errorFor = (field: ErrorField) => (errorField === field ? { error: message } : {});

  /*
   * #214 review F2 — an inline error is not a live region, so the refused
   * field takes focus: a screen reader then reads its label, its value and its
   * description, which holds the error. Keyed on the state object, so each
   * refusal moves focus once rather than on every render.
   */
  useEffect(() => {
    if (errorField !== undefined) document.getElementById(FIELD_IDS[errorField])?.focus();
  }, [state]);

  return (
    <form action={formAction} onSubmit={remember}>
      {/* SPEC-022 BR-022-37 — the standard form: one panel, its three groups
          of fields two to a row, and Cancelar then the primary action at the
          footer's right. */}
      <FormPanel
        title={t('panelTitle')}
        alert={refusal && errorField === undefined ? <ErrorState title={message} /> : undefined}
        footer={
          <FormActions
            cancel={
              <Button asChild variant="outline">
                <Link href="/transactions">{t('cancel')}</Link>
              </Button>
            }
          >
            <Button type="submit" disabled={pending}>
              {pending ? t('submitting') : t(mode === 'create' ? 'submitCreate' : 'submitEdit')}
            </Button>
          </FormActions>
        }
      >
        {/* The fields re-mount per submission, so React's post-action reset
            lands on what was posted rather than on the page's original
            values. The buttons stay outside, in the footer, so the one just
            pressed keeps focus through a refusal shown in the banner. */}
        <Stack gap="lg" key={submissions}>
          {values.transactionId !== undefined && (
            <input type="hidden" name="transactionId" value={values.transactionId} />
          )}

          <FormGrid legend={t('assetSection')}>
            <Field id="transaction-asset" label={t('assetExisting')} span="full">
              <NativeSelect name="assetId" defaultValue={draft.assetId}>
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
            >
              <Input name="assetCode" autoComplete="off" defaultValue={draft.assetCode ?? ''} />
            </Field>
            <Field id="transaction-asset-name" label={t('assetNewName')}>
              <Input name="assetName" autoComplete="off" defaultValue={draft.assetName ?? ''} />
            </Field>
            <Field id="transaction-asset-class" label={t('assetNewClass')}>
              {/* #110: blank states nothing, so typing an existing code never
                  overwrites the class Posição stated. */}
              <NativeSelect name="assetClass" defaultValue={draft.assetClass ?? ''}>
                <option value="">{t('assetNewClassUnstated')}</option>
                {assetClasses.map((value) => (
                  <option key={value} value={value}>
                    {tAssetClass(value)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </FormGrid>

          <FormGrid legend={t('institutionSection')}>
            <Field id="transaction-institution" label={t('institutionExisting')}>
              <NativeSelect name="institutionId" defaultValue={draft.institutionId}>
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
            <Field id="transaction-institution-name" label={t('institutionNew')}>
              <Input
                name="institutionName"
                autoComplete="off"
                defaultValue={draft.institutionName ?? ''}
              />
            </Field>
          </FormGrid>

          <FormGrid legend={t('detailsSection')}>
            {/* BR-006-05: grouped conversion legs are never edited alone. */}
            <Field id="transaction-type" label={t('type')}>
              <NativeSelect name="type" defaultValue={draft.type} required>
                {USER_EDITABLE_TRANSACTION_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {tType(value)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id="transaction-date" label={t('tradeDate')} {...errorFor('tradeDate')}>
              <Input type="date" name="tradeDate" defaultValue={draft.tradeDate} required />
            </Field>

            {/*
              `inputMode="decimal"` on a text field rather than
              `type="number"`: a pt-BR keyboard produces `32,15`, which a
              number input refuses to submit at all. `lib/decimal-input.ts`
              reads both forms, and AR-06 keeps the value a string the whole
              way to `Money`/`Quantity`.
            */}
            <Field id="transaction-quantity" label={t('quantity')} {...errorFor('quantity')}>
              <Input name="quantity" inputMode="decimal" defaultValue={draft.quantity} required />
            </Field>
            <Field
              id="transaction-price"
              label={t('unitPrice')}
              hint={t('decimalHint')}
              {...errorFor('unitPrice')}
            >
              <Input name="unitPrice" inputMode="decimal" defaultValue={draft.unitPrice} required />
            </Field>
            <Field id="transaction-fees" label={t('fees')} {...errorFor('fees')}>
              <Input name="fees" inputMode="decimal" defaultValue={draft.fees} />
            </Field>
            {/* SPEC-007 BR-007-04 — split and grupamento only. */}
            <Field
              id="transaction-ratio"
              label={t('ratio')}
              hint={t('ratioHint')}
              {...errorFor('ratio')}
            >
              <Input name="ratio" inputMode="decimal" defaultValue={draft.ratio} />
            </Field>
            {/*
              SPEC-010 BR-010-17 / AC-010-15 — "a sale with a specified wallet
              reduces only that wallet". `applySell` has accepted a wallet
              since it was written and nothing ever passed one, so the rule
              held in unit tests and nowhere else (#61).

              Always rendered rather than revealed for reducing types only,
              matching `ratio` above: the form degrades without JavaScript, and
              the hint says when it applies. Left empty it means "no statement",
              which is BR-010-17's proportional reduction across every wallet
              holding the asset — the default, and the only honest reading of
              an unanswered question.
            */}
            {walletOptions.length > 0 && (
              <Field
                id="transaction-sold-from"
                label={t('soldFromWallet')}
                hint={t('soldFromWalletHint')}
                span="full"
              >
                <NativeSelect name="soldFromWallet" defaultValue={draft.soldFromWallet ?? ''}>
                  <option value="">{t('soldFromWalletProportional')}</option>
                  {walletOptions.map((wallet) => (
                    <option key={wallet.walletId} value={wallet.walletId}>
                      {wallet.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            )}
          </FormGrid>
        </Stack>
      </FormPanel>
    </form>
  );
}
