'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { WalletErrorCode } from '@/core/wallets/errors';
import { IDLE, messageValues, type ActionState } from '@/lib/action-state';
import { ColorInput } from '@/components/patterns/color-input';
import { ErrorState } from '@/components/patterns/error-state';
import { Field } from '@/components/patterns/field';
import { Cluster } from '@/components/layout/cluster';
import { Stack } from '@/components/layout/stack';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';

/**
 * SPEC-010 BR-010-01/02 — a wallet's name, description, purpose and colour,
 * for both **creating** (Configurações › Carteiras › Nova carteira) and
 * **editing** (a wallet's Dados). One form, so the two cannot drift apart.
 *
 * **A refusal lands under its field** (SPEC-022 BR-022-21). `INVALID_NAME` —
 * a blank or whitespace name, which the input's own `required` cannot see — is
 * said under Nome; anything that is not about one field stays in the banner
 * above the form (`ActionForm`'s place for it). The domain, not this component,
 * decides what is a refusal: the code arrives from the action and the message
 * from the `errors` catalogue (AR-38).
 *
 * **The user's typing survives a refusal.** React resets an uncontrolled form
 * once its action finishes, which would empty Descrição, Objetivo and Cor
 * because Nome was blank. The values the action was given are kept as the
 * fields' defaults, so the reset restores them instead of the page's.
 *
 * Instructions sit behind the info icon and never change a field's height
 * (BR-022-20); every control here is `h-8`, so the four stay aligned in a row
 * or a column. The action is passed in: `createWalletAction` redirects to the
 * new wallet on success, `updateWalletAction` stays and returns `saved`.
 */
export interface WalletFormValues {
  readonly name: string;
  readonly description: string;
  readonly goal: string;
  readonly color: string | null;
}

const EMPTY: WalletFormValues = { name: '', description: '', goal: '', color: null };

export function WalletForm({
  action,
  idPrefix,
  submitLabel,
  walletId,
  values = EMPTY,
  cancelHref,
}: {
  readonly action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  /** Field ids must be unique on the page, and a wallet page has several forms. */
  readonly idPrefix: string;
  readonly submitLabel: string;
  /** Present when editing: the wallet the action changes. */
  readonly walletId?: string;
  readonly values?: WalletFormValues;
  /** Present when creating: where Cancelar goes. */
  readonly cancelHref?: string;
}) {
  const t = useTranslations('wallets');
  const tErrors = useTranslations('errors');
  const [draft, setDraft] = useState(values);
  /*
   * #210 review R2-1 — the colour control is controlled, and React's form
   * reset after an action restores a controlled checkbox to its *first*
   * render, not to its state: "Sem cor" would show one thing and post another.
   * Re-mounting it from the posted values on every submission makes those
   * values its defaults, so the reset lands on what was actually sent.
   */
  const [submissions, setSubmissions] = useState(0);
  const [state, formAction, pending] = useActionState(
    async (previous: ActionState, formData: FormData) => {
      setSubmissions((count) => count + 1);
      setDraft({
        name: String(formData.get('name') ?? ''),
        description: String(formData.get('description') ?? ''),
        goal: String(formData.get('goal') ?? ''),
        color:
          formData.get('noColor') === 'on' ? null : String(formData.get('color') ?? '') || null,
      });
      return action(previous, formData);
    },
    IDLE,
  );

  const refusal = state.status === 'error' ? state : null;
  const message = refusal ? tErrors(refusal.code, messageValues(refusal.context)) : undefined;
  const nameRefused = refusal?.code === WalletErrorCode.INVALID_NAME;

  return (
    <form action={formAction}>
      <Stack gap="md">
        {refusal && !nameRefused && <ErrorState title={message} />}
        {walletId !== undefined && <input type="hidden" name="walletId" value={walletId} />}

        <Field
          id={`${idPrefix}-name`}
          label={t('nameLabel')}
          width="full"
          {...(nameRefused ? { error: message } : {})}
        >
          <Input
            name="name"
            required
            defaultValue={draft.name}
            placeholder={t('namePlaceholder')}
          />
        </Field>
        <Field id={`${idPrefix}-description`} label={t('descriptionLabel')} width="full">
          <Input name="description" defaultValue={draft.description} />
        </Field>
        <Field id={`${idPrefix}-goal`} label={t('goalLabel')} hint={t('goalHint')} width="full">
          <Input name="goal" defaultValue={draft.goal} />
        </Field>
        <Field id={`${idPrefix}-color`} label={t('colorLabel')} width="full">
          <ColorInput
            key={submissions}
            name="color"
            defaultValue={draft.color}
            noneLabel={t('colorNone')}
          />
        </Field>

        <Cluster gap="sm" justify="end">
          <Text as="span" size="xs" tone="muted" role="status">
            {state.status === 'saved' ? t('saved') : ''}
          </Text>
          {cancelHref !== undefined && (
            <Button asChild variant="outline">
              <Link href={cancelHref}>{t('cancel')}</Link>
            </Button>
          )}
          <Button type="submit" disabled={pending}>
            {submitLabel}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
