'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { WalletErrorCode } from '@/core/wallets/errors';
import { IDLE, messageValues, type ActionState } from '@/lib/action-state';
import { ErrorState } from '@/components/patterns/error-state';
import { Field, FieldAction } from '@/components/patterns/field';
import { Cluster } from '@/components/layout/cluster';
import { Stack } from '@/components/layout/stack';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';

/**
 * SPEC-010 BR-010-03/09/13 — assigning a held asset to a wallet, in the two
 * places it is offered: the **wallet's own page** (pick an asset, the wallet is
 * fixed) and the **"Precisa de atenção" queue** (the asset is fixed, pick a
 * wallet). Same action, same quantity field, so a refusal reads the same.
 *
 * **A refusal lands under Quantidade** (SPEC-022 BR-022-21):
 * `ALLOCATION_EXCEEDS_HOLDINGS` (BR-010-05 — the message names the held
 * quantity, which is what tells the user what the ceiling is) and
 * `INVALID_ALLOCATION_QUANTITY` are both about that one field. Anything else —
 * a wallet that no longer exists, say — is not, and stays in the banner.
 *
 * An empty Quantidade is meaningful: the action allocates everything not yet
 * assigned in one click (BR-010-03). The queue pre-fills it with that
 * remainder (BR-010-13); the wallet's own page leaves it empty and says so.
 * What was typed survives a refusal (React would otherwise reset the form to
 * its defaults), so correcting a number does not mean choosing again.
 */
export interface AllocateChoice {
  /** The form field the choice posts as: the wallet in the queue, the asset on a wallet's page. */
  readonly name: 'walletId' | 'assetId';
  readonly label: string;
  readonly placeholder: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

const QUANTITY_CODES: readonly string[] = [
  WalletErrorCode.ALLOCATION_EXCEEDS_HOLDINGS,
  WalletErrorCode.INVALID_ALLOCATION_QUANTITY,
];

export function AllocateForm({
  action,
  idPrefix,
  fixed,
  choice,
  defaultQuantity = '',
  quantityHint,
  submitLabel,
}: {
  readonly action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  /** Unique on the page: the queue has one form per asset. */
  readonly idPrefix: string;
  /** The half of the pair that is already decided, posted as a hidden field. */
  readonly fixed: { readonly name: 'walletId' | 'assetId'; readonly value: string };
  readonly choice: AllocateChoice;
  readonly defaultQuantity?: string;
  /** Instructions for Quantidade, behind its info icon (BR-022-20). */
  readonly quantityHint?: string;
  readonly submitLabel: string;
}) {
  const t = useTranslations('wallets');
  const tErrors = useTranslations('errors');
  const [draft, setDraft] = useState({ choice: '', quantity: defaultQuantity });
  const [state, formAction, pending] = useActionState(
    async (previous: ActionState, formData: FormData) => {
      setDraft({
        choice: String(formData.get(choice.name) ?? ''),
        quantity: String(formData.get('quantity') ?? ''),
      });
      return action(previous, formData);
    },
    IDLE,
  );

  const refusal = state.status === 'error' ? state : null;
  const message = refusal ? tErrors(refusal.code, messageValues(refusal.context)) : undefined;
  const quantityRefused = refusal !== null && QUANTITY_CODES.includes(refusal.code);

  return (
    <form action={formAction}>
      <Stack gap="sm">
        {refusal && !quantityRefused && <ErrorState title={message} />}
        <input type="hidden" name={fixed.name} value={fixed.value} />
        <Cluster gap="sm" align="start">
          <Field id={`${idPrefix}-choice`} label={choice.label} width="md">
            {/* `key`: a native select does not follow a changed `defaultValue`, so the
                choice is remounted with the one that was submitted. */}
            <NativeSelect
              key={draft.choice}
              name={choice.name}
              required
              defaultValue={draft.choice}
            >
              <option value="">{choice.placeholder}</option>
              {choice.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field
            id={`${idPrefix}-quantity`}
            label={t('assignQuantity')}
            width="md"
            {...(quantityHint ? { hint: quantityHint } : {})}
            {...(quantityRefused ? { error: message } : {})}
          >
            <Input name="quantity" inputMode="decimal" defaultValue={draft.quantity} />
          </Field>
          <FieldAction>
            <Button type="submit" disabled={pending}>
              {submitLabel}
            </Button>
          </FieldAction>
        </Cluster>
      </Stack>
    </form>
  );
}
