'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { IDLE, messageValues, type ActionState } from '@/lib/action-state';
import { Field } from '@/components/patterns/field';
import { ErrorState } from '@/components/patterns/error-state';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

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
}

export function UploadForm({ action }: UploadFormProps) {
  const t = useTranslations('import');
  const tErrors = useTranslations('errors');
  const [state, formAction, pending] = useActionState(action, IDLE);

  return (
    <form action={formAction}>
      <Stack gap="md">
        {state.status === 'error' && (
          <ErrorState title={tErrors(state.code, messageValues(state.context))} />
        )}
        <Cluster gap="md" align="end">
          <Field id="extract-file" label={t('fileLabel')} hint={t('fileHint')}>
            <Input type="file" name="file" accept=".xlsx,.xls" multiple required />
          </Field>
          <Button type="submit" disabled={pending}>
            {pending ? t('uploading') : t('upload')}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
