'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Field } from '@/components/patterns/field';
import { FieldGroup } from '@/components/patterns/field-group';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Text } from '@/components/ui/text';
import type { SaveParameterState } from '@/app/parameter-actions';

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
  | { readonly kind: 'number'; readonly value: number | undefined };

export interface ParameterOption {
  readonly value: string;
  readonly label: string;
}

const IDLE: SaveParameterState = { status: 'idle' };

/**
 * One parameter, its own form. A refused save is said under the field
 * (SPEC-022 BR-022-21) with the range the key permits, rather than the form
 * quietly reverting — `setConfigValue` re-validates every write against the
 * key's schema (BR-002-04), and a refusal nobody sees reads as a save.
 */
export function ParameterField({
  id,
  label,
  hint,
  invalidMessage,
  control,
  action,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  /** What a refusal says: the permitted range where the schema has one. */
  readonly invalidMessage: string;
  readonly control: ParameterControl;
  readonly action: (state: SaveParameterState, formData: FormData) => Promise<SaveParameterState>;
}) {
  const t = useTranslations('parameters');
  const [state, formAction, pending] = useActionState(action, IDLE);
  const error = state.status === 'error' ? invalidMessage : undefined;

  return (
    <form action={formAction}>
      <Stack gap="sm" align="start">
        {control.kind === 'choices' ? (
          <Choices id={id} label={label} hint={hint} error={error} control={control} />
        ) : (
          <Field id={id} label={label} hint={hint} error={error}>
            <SingleControl control={control} />
          </Field>
        )}
        <Cluster gap="sm" align="center">
          <Button type="submit" disabled={pending}>
            {t('save')}
          </Button>
          <Text as="span" size="xs" tone="muted" role="status">
            {state.status === 'saved' ? t('saved') : ''}
          </Text>
        </Cluster>
      </Stack>
    </form>
  );
}

function SingleControl({
  control,
  ...fieldProps
}: {
  control: Exclude<ParameterControl, { kind: 'choices' }>;
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}) {
  if (control.kind === 'boolean') {
    return <Checkbox {...fieldProps} name="value" defaultChecked={control.value} />;
  }

  if (control.kind === 'enum') {
    return (
      <NativeSelect {...fieldProps} name="value" defaultValue={control.value} className="w-fit">
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
    <Input
      {...fieldProps}
      name="value"
      type="number"
      step="any"
      defaultValue={control.value}
      className="w-32"
    />
  );
}

/** The array case: a checkbox group, labelled and described by `FieldGroup`. */
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
              name="value"
              value={option.value}
              defaultChecked={control.value.includes(option.value)}
            />
            {option.label}
          </Label>
        ))}
      </Cluster>
    </FieldGroup>
  );
}
