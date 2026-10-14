'use client';

import { useActionState, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { WalletErrorCode } from '@/core/wallets/errors';
import { IDLE, messageValues, type ActionState } from '@/lib/action-state';
import { ColorInput } from '@/components/patterns/color-input';
import { ErrorState } from '@/components/patterns/error-state';
import { Field } from '@/components/patterns/field';
import { FormActions, FormGrid, FormPanel } from '@/components/patterns/form-layout';
import { InfoTip } from '@/components/patterns/info-tip';
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
 *
 * **The standard form** (SPEC-022 BR-022-37, the "Editar carteira" frame): a
 * panel titled with the wallet, Nome beside Cor, the two free texts across
 * both columns, and a footer with Excluir carteira alone at the left and
 * Cancelar, then the primary action, at the right.
 *
 * **Excluir carteira posts this same form to another action** — the button's
 * `formAction` — so it sits in the footer the frame draws without a second
 * `<form>` nested in the first, which HTML does not allow. Its `formNoValidate`
 * lets a wallet be deleted while Nome is blank. BR-010-07's consequences —
 * the assignments return to Não atribuído, no transaction is touched — are its
 * instructions, behind the info icon beside it and in its description.
 */
export interface WalletFormValues {
  readonly name: string;
  readonly description: string;
  readonly goal: string;
  readonly color: string | null;
}

const EMPTY: WalletFormValues = { name: '', description: '', goal: '', color: null };

type WalletAction = (state: ActionState, formData: FormData) => Promise<ActionState>;

const NO_DELETE: WalletAction = async () => IDLE;

export function WalletForm({
  action,
  deleteAction,
  idPrefix,
  title,
  description,
  headerActions,
  submitLabel,
  walletId,
  values = EMPTY,
  cancelHref,
}: {
  readonly action: WalletAction;
  /** Present when editing: Excluir carteira, at the footer's left. */
  readonly deleteAction?: WalletAction;
  /** Field ids must be unique on the page, and a wallet page has several forms. */
  readonly idPrefix: string;
  readonly title: React.ReactNode;
  readonly description?: React.ReactNode;
  /** Links in the panel's header, beside the title. */
  readonly headerActions?: React.ReactNode;
  readonly submitLabel: string;
  /** Present when editing: the wallet the action changes. */
  readonly walletId?: string;
  readonly values?: WalletFormValues;
  /** Where Cancelar goes. */
  readonly cancelHref: string;
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
  /*
   * The server action goes to the hook **as is** (DS-37, PR #229 review): a
   * client function wrapped around it has no `$$FORM_ACTION`, and the form
   * would render with nowhere to post when JavaScript is off. What was sent is
   * read in `onSubmit` instead, which runs before the action is dispatched.
   */
  const [state, formAction, pending] = useActionState(action, IDLE);
  // A hook cannot be conditional, so a create form holds an inert one.
  const [deleteState, deleteFormAction, deleting] = useActionState(deleteAction ?? NO_DELETE, IDLE);
  const remember = (event: FormEvent<HTMLFormElement>) => {
    const formData = new FormData(event.currentTarget);
    setSubmissions((count) => count + 1);
    setDraft({
      name: String(formData.get('name') ?? ''),
      description: String(formData.get('description') ?? ''),
      goal: String(formData.get('goal') ?? ''),
      color: formData.get('noColor') === 'on' ? null : String(formData.get('color') ?? '') || null,
    });
  };

  const refusal = state.status === 'error' ? state : null;
  const message = refusal ? tErrors(refusal.code, messageValues(refusal.context)) : undefined;
  const nameRefused = refusal?.code === WalletErrorCode.INVALID_NAME;
  const deleteRefusal =
    deleteState.status === 'error'
      ? tErrors(deleteState.code, messageValues(deleteState.context))
      : undefined;
  const deleteHintId = `${idPrefix}-delete-hint`;

  return (
    <form action={formAction} onSubmit={remember}>
      <FormPanel
        title={title}
        description={description}
        actions={headerActions}
        alert={
          (refusal && !nameRefused) || deleteRefusal !== undefined ? (
            <ErrorState title={deleteRefusal ?? message} />
          ) : undefined
        }
        footer={
          <FormActions
            destructive={
              deleteAction !== undefined && (
                <>
                  <Button
                    id={`${idPrefix}-delete`}
                    type="submit"
                    variant="destructive"
                    formAction={deleteFormAction}
                    formNoValidate
                    disabled={deleting}
                    aria-describedby={deleteHintId}
                  >
                    {t('delete')}
                  </Button>
                  <InfoTip
                    id={`${idPrefix}-delete-info`}
                    label={t('delete')}
                    labelledBy={`${idPrefix}-delete`}
                  >
                    {t('deleteDescription')}
                  </InfoTip>
                  <span id={deleteHintId} hidden>
                    {t('deleteDescription')}
                  </span>
                </>
              )
            }
            status={
              <Text as="span" size="xs" tone="muted" role="status">
                {state.status === 'saved' ? t('saved') : ''}
              </Text>
            }
            cancel={
              <Button asChild variant="outline">
                <Link href={cancelHref}>{t('cancel')}</Link>
              </Button>
            }
          >
            <Button type="submit" disabled={pending}>
              {submitLabel}
            </Button>
          </FormActions>
        }
      >
        {walletId !== undefined && <input type="hidden" name="walletId" value={walletId} />}

        <FormGrid>
          <Field
            id={`${idPrefix}-name`}
            label={t('nameLabel')}
            {...(nameRefused ? { error: message } : {})}
          >
            <Input
              name="name"
              required
              defaultValue={draft.name}
              placeholder={t('namePlaceholder')}
            />
          </Field>
          <Field id={`${idPrefix}-color`} label={t('colorLabel')}>
            <ColorInput
              key={submissions}
              name="color"
              defaultValue={draft.color}
              noneLabel={t('colorNone')}
            />
          </Field>
          <Field id={`${idPrefix}-description`} label={t('descriptionLabel')} span="full">
            <Input name="description" defaultValue={draft.description} />
          </Field>
          <Field id={`${idPrefix}-goal`} label={t('goalLabel')} hint={t('goalHint')} span="full">
            <Input name="goal" defaultValue={draft.goal} />
          </Field>
        </FormGrid>
      </FormPanel>
    </form>
  );
}
