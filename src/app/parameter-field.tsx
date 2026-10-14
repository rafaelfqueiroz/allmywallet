'use client';

import { useActionState, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import type { ConfigKey } from '@/config/registry';
import { Field } from '@/components/patterns/field';
import { FieldGroup } from '@/components/patterns/field-group';
import { FormActions, FormGrid, FormPanel } from '@/components/patterns/form-layout';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Text } from '@/components/ui/text';
import type { SaveParametersState } from '@/app/parameter-actions';
import { loadedFieldName } from '@/app/parameter-names';

/**
 * The control a registry key renders as, worked out on the server from its
 * Zod schema — a schema cannot cross into a Client Component, this can.
 * Option labels arrive translated (BR-022-23): a select never shows a raw
 * registry value such as `asset_class`.
 */
export type ParameterControl =
  | { readonly kind: 'boolean'; readonly value: boolean }
  | {
      readonly kind: 'enum';
      readonly value: string;
      readonly options: readonly ParameterOption[];
    }
  | {
      readonly kind: 'choices';
      readonly value: readonly string[];
      readonly options: readonly ParameterOption[];
    }
  | { readonly kind: 'number'; readonly value: number | string | undefined };

export interface ParameterOption {
  readonly value: string;
  readonly label: string;
}

const IDLE: SaveParametersState = { status: 'idle' };

/** One key as the form renders it, everything translated on the server. */
export interface ParameterEntry {
  readonly key: ConfigKey;
  readonly label: string;
  readonly hint: string;
  /** What a refusal says: the permitted range where the schema has one. */
  readonly invalidMessage: string;
  readonly control: ParameterControl;
}

/**
 * One surface's parameters as **one standard form** (SPEC-022 BR-022-37): a
 * panel, the keys two to a row — a group of choices across both columns —
 * and Cancelar, then Salvar, at the footer's right. Cancelar is a native
 * `reset`: it returns every field to what was loaded, with or without
 * JavaScript.
 *
 * A refused save is said under each refused field (BR-022-21) with the range
 * the key permits, rather than the form quietly reverting — a refusal nobody
 * sees reads as a save. **What was typed survives a refusal**: React resets an
 * uncontrolled form once its action finishes, which would put every key back
 * because one was out of range, so the posted values become the fields'
 * defaults and the fields re-mount with them (the `WalletForm` pattern).
 */
export function ParameterFields({
  title,
  description,
  parameters,
  action,
}: {
  readonly title: React.ReactNode;
  readonly description?: React.ReactNode;
  readonly parameters: readonly ParameterEntry[];
  readonly action: (state: SaveParametersState, formData: FormData) => Promise<SaveParametersState>;
}) {
  const t = useTranslations('parameters');
  // The server action goes to the hook as is, so the form posts without
  // JavaScript (DS-37); what was sent is read in `onSubmit`.
  const [state, formAction, pending] = useActionState(action, IDLE);
  const [posted, setPosted] = useState<{ count: number; data: FormData | null }>({
    count: 0,
    data: null,
  });
  const remember = (event: FormEvent<HTMLFormElement>) => {
    const data = new FormData(event.currentTarget);
    setPosted((previous) => ({ count: previous.count + 1, data }));
  };
  // While a save is pending and after a refusal the fields show what was
  // posted — a native select does not follow a changed default, so they
  // re-mount on each submission. After a save the server's own values, now
  // equal to them, are the defaults again, so a change made elsewhere since
  // (the eye toggle's `ui.hide_values`) shows here rather than a stale draft.
  const draft = pending || state.status === 'error' ? posted.data : null;
  const invalid = new Set(state.status === 'error' ? (state.invalid ?? []) : []);

  return (
    <form action={formAction} onSubmit={remember}>
      <FormPanel
        title={title}
        description={description}
        footer={
          <FormActions
            status={
              <Text as="span" size="xs" tone="muted" role="status">
                {state.status === 'saved' ? t('saved') : ''}
              </Text>
            }
            cancel={
              // Back to what was loaded, not to a refused draft. On the button,
              // not the form's `onReset`: React resets the form itself after
              // every action, refusals included, and that must keep the draft.
              <Button
                type="reset"
                variant="outline"
                onClick={() => setPosted((previous) => ({ count: previous.count + 1, data: null }))}
              >
                {t('cancel')}
              </Button>
            }
          >
            <Button type="submit" disabled={pending}>
              {t('save')}
            </Button>
          </FormActions>
        }
      >
        <FormGrid key={posted.count}>
          {/* What each field was loaded with, kept with the field's own mount
              (#248 review): only a key the user changed is written, so a save
              here cannot undo a change made elsewhere since — the eye
              toggle's `ui.hide_values`. A revalidation refreshes `parameters`
              but not an uncontrolled control already on screen, so the
              reference must not follow it either. */}
          {parameters.map(({ key, control }) => (
            <LoadedValue key={`loaded-${key}`} name={loadedFieldName(key)} value={control.value} />
          ))}
          {parameters.map(({ key, label, hint, invalidMessage, control }) => {
            const error = invalid.has(key) ? invalidMessage : undefined;
            const value = draft === null ? control : withDraft(control, key, draft);
            return value.kind === 'choices' ? (
              <Choices key={key} id={key} label={label} hint={hint} error={error} control={value} />
            ) : (
              <Field key={key} id={key} label={label} hint={hint} error={error}>
                <SingleControl name={key} control={value} />
              </Field>
            );
          })}
        </FormGrid>
      </FormPanel>
    </form>
  );
}

/** A hidden reference fixed when its field mounts; see `ParameterFields`. */
function LoadedValue({ name, value }: { name: string; value: unknown }) {
  const [loaded] = useState(() => JSON.stringify(value ?? null));
  return <input type="hidden" name={name} value={loaded} />;
}

/** The control as it was posted, so a refusal does not undo the typing. */
function withDraft(control: ParameterControl, key: string, data: FormData): ParameterControl {
  switch (control.kind) {
    case 'boolean':
      return { kind: 'boolean', value: data.get(key) === 'on' };
    case 'choices':
      return { ...control, value: data.getAll(key).map(String) };
    case 'enum':
      return { ...control, value: String(data.get(key) ?? control.value) };
    case 'number': {
      const raw = data.get(key);
      return { kind: 'number', value: raw === null || raw === '' ? undefined : String(raw) };
    }
  }
}

function SingleControl({
  name,
  control,
  ...fieldProps
}: {
  name: string;
  control: Exclude<ParameterControl, { kind: 'choices' }>;
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}) {
  if (control.kind === 'boolean') {
    return <Checkbox {...fieldProps} name={name} defaultChecked={control.value} />;
  }

  if (control.kind === 'enum') {
    return (
      <NativeSelect {...fieldProps} name={name} defaultValue={control.value}>
        {control.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </NativeSelect>
    );
  }

  /*
   * `step="any"` because the registry holds both integer keys
   * (`import.staleness_days`) and fractional ones — SPEC-017's
   * `wallets.drift_tolerance_pp` is a tolerance in percentage points, where
   * 0,5 is a legitimate setting for a wallet of four assets. No `min`/`max`
   * either: the browser would refuse with its own bubble, in whatever language
   * it runs in (BR-022-23). The server re-validates against the key's schema
   * and the refusal renders under the field with the range, in pt-BR.
   */
  return (
    <Input {...fieldProps} name={name} type="number" step="any" defaultValue={control.value} />
  );
}

/**
 * The array case: a checkbox group, labelled and described by `FieldGroup`.
 * A list of choices is long, so it takes both columns.
 */
function Choices({
  id,
  label,
  hint,
  error,
  control,
}: {
  id: string;
  label: string;
  hint: string;
  error: string | undefined;
  control: Extract<ParameterControl, { kind: 'choices' }>;
}) {
  return (
    <div className="col-span-full">
      <FieldGroup id={id} legend={label} hint={hint} error={error}>
        <Cluster gap="md">
          {control.options.map((option) => (
            <Label
              key={option.value}
              htmlFor={`${id}-${option.value}`}
              className="text-sm font-normal"
            >
              <Checkbox
                id={`${id}-${option.value}`}
                name={id}
                value={option.value}
                defaultChecked={control.value.includes(option.value)}
              />
              {option.label}
            </Label>
          ))}
        </Cluster>
      </FieldGroup>
    </div>
  );
}
