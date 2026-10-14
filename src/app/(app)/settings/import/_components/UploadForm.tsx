'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { IDLE, messageValues, type ActionState } from '@/lib/action-state';
import { Field } from '@/components/patterns/field';
import { FormActions, FormPanel } from '@/components/patterns/form-layout';
import { FileUpload } from '@/components/patterns/file-upload';
import { Stack } from '@/components/layout/stack';
import { Button } from '@/components/ui/button';

/**
 * SPEC-005 — the upload control.
 *
 * `multiple`, because the spec's acceptance criterion is "files upload
 * together **or** individually, in any order" and B3 exports three of them.
 * Order needs nothing here: each file becomes its own batch and the worker
 * identifies what it is from the bytes (BR-005-03).
 *
 * A Client Component only for the refusal. `uploadExtractAction` used to
 * return `void` and drop an oversized file silently, which was survivable
 * while one file was one submission and is not survivable now — a user who
 * picks three and gets two has a partial import, and every later
 * reconciliation discrepancy would look like their broker's fault. React binds
 * the action to the form's native POST, so this still submits and still
 * renders its error without JavaScript.
 */
export interface UploadFormProps {
  readonly action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  /**
   * Importar › Enviar's own panel (SPEC-022 BR-022-37, the "Enviar extrato"
   * frame): the drop zone in the body and Enviar at the footer's right.
   * Without it the form sits inline, inside a panel that holds more than the
   * upload — the onboarding step.
   */
  readonly panel?: { readonly title: React.ReactNode; readonly description?: React.ReactNode };
}

export function UploadForm({ action, panel }: UploadFormProps) {
  const t = useTranslations('import');
  const tErrors = useTranslations('errors');
  const [state, formAction, pending] = useActionState(action, IDLE);

  // The refusal renders inside the drop zone (SPEC-022 BR-022-21/23), where
  // the user's eye already is, rather than as a banner above it.
  const field = (
    <Field id="extract-file" label={t('fileLabel')} hint={t('fileHint')} width="full">
      <FileUpload
        name="file"
        accept=".xlsx,.xls"
        multiple
        required
        title={t('dropTitle')}
        acceptHint={t('acceptHint')}
        {...(state.status === 'error'
          ? { error: tErrors(state.code, messageValues(state.context)) }
          : {})}
      />
    </Field>
  );
  const submit = (
    <Button type="submit" disabled={pending}>
      {pending ? t('uploading') : t('upload')}
    </Button>
  );

  if (panel !== undefined) {
    return (
      <form action={formAction}>
        <FormPanel
          title={panel.title}
          description={panel.description}
          footer={<FormActions>{submit}</FormActions>}
        >
          {field}
        </FormPanel>
      </form>
    );
  }

  return (
    <form action={formAction}>
      <Stack gap="md">
        {field}
        <div>{submit}</div>
      </Stack>
    </form>
  );
}
