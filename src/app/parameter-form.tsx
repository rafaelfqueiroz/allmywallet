import type * as React from 'react';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { REGISTRY, type ConfigKey, type ParameterSurface } from '@/config/registry';
import { loadParameters } from '@/app/parameter-data';
import { submitParameterForm } from '@/app/parameter-actions';
import { Field } from '@/components/patterns/field';
import { Section } from '@/components/patterns/section';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { List, ListItem } from '@/components/layout/list';
import { Text } from '@/components/ui/text';

/**
 * SPEC-022 BR-022-13 / DL-022-10 — the parameter-form pattern: one field per
 * user-settable registry key on `surface`, each a form of its own that saves
 * through `setConfigValue` (BR-002-03/04).
 *
 * Preferências renders `surface="preferences"`; each Configurações section
 * renders its own `settings.*` surface. Nothing here, and nothing on those
 * pages, lists a key: add a key with `levels: [..., 'user']` and a `surface`
 * in src/config/registry.ts and it appears on that screen with no other change
 * (SPEC-002 BR-002-01, DESIGN.md DS-30).
 *
 * The caller must be signed in — the page renders its own signed-out state,
 * because what a visitor is told differs from screen to screen.
 */
export async function ParameterForm({ surface }: { surface: ParameterSurface }) {
  const parameters = await loadParameters(surface);

  return (
    <List gap="lg">
      {parameters.map((entry) => (
        <ListItem key={entry.key} separated>
          <ParameterField parameterKey={entry.key} value={entry.value} />
        </ListItem>
      ))}
    </List>
  );
}

/**
 * A Configurações section's parameters, under one heading, so the sections
 * cannot word it three ways. Until #210–#212 move each feature under
 * Configurações, it renders on the feature's current screen — the screen
 * those issues move.
 */
export async function ParameterSection({
  surface,
}: {
  surface: Exclude<ParameterSurface, 'preferences'>;
}) {
  const t = await getTranslations('parameters');
  return (
    <Section title={t('sectionTitle')} description={t('sectionDescription')}>
      <ParameterForm surface={surface} />
    </Section>
  );
}

async function ParameterField({
  parameterKey,
  value,
}: {
  parameterKey: ConfigKey;
  value: unknown;
}) {
  const t = await getTranslations('parameters');
  const entry = REGISTRY[parameterKey];
  const action = submitParameterForm.bind(null, parameterKey);

  const label = t(`keys.${parameterKey}.label` as Parameters<typeof t>[0]);
  const description = t(`keys.${parameterKey}.description` as Parameters<typeof t>[0]);

  /*
   * The array case is a checkbox group, which has no single control to point a
   * label at — it needs a `fieldset`/`legend`, not a `label`/`for`. `Field`
   * would produce a label referencing an id that does not exist, so the group
   * builds its own grouping semantics instead.
   */
  if (entry.schema instanceof z.ZodArray) {
    return (
      <form action={action}>
        <Stack gap="sm" align="start">
          <fieldset>
            <Stack gap="sm">
              <legend className="text-sm font-medium">{label}</legend>
              <Text size="xs" tone="muted">
                {description}
              </Text>
              <ParameterChoices parameterKey={parameterKey} value={value} />
            </Stack>
          </fieldset>
          <Button type="submit">{t('save')}</Button>
          <input type="hidden" name="_range" value={entry.range} />
        </Stack>
      </form>
    );
  }

  return (
    <form action={action}>
      <Stack gap="sm" align="start">
        <Field id={parameterKey} label={label} hint={description}>
          <ParameterControl parameterKey={parameterKey} value={value} />
        </Field>
        <Button type="submit">{t('save')}</Button>
        {/* Range/description live on the registry entry, not repeated here — entry.range documents it for operators. */}
        <input type="hidden" name="_range" value={entry.range} />
      </Stack>
    </form>
  );
}

/** The single-control cases, which `Field` can label and describe. */
function ParameterControl({
  parameterKey,
  value,
  ...controlProps
}: {
  parameterKey: ConfigKey;
  /** The stored config value, which is `unknown` until the schema narrows it —
   * deliberately shadowing the DOM `value` attribute, which this never sets. */
  value: unknown;
} & Omit<React.ComponentProps<'input'>, 'value'>) {
  const entry = REGISTRY[parameterKey];

  if (entry.schema instanceof z.ZodBoolean) {
    return <Checkbox {...controlProps} name="value" defaultChecked={value === true} />;
  }

  if (entry.schema instanceof z.ZodEnum) {
    const options = Object.values(entry.schema.enum) as string[];
    return (
      <NativeSelect
        {...(controlProps as React.ComponentProps<'select'>)}
        name="value"
        defaultValue={typeof value === 'string' ? value : options[0]}
        className="w-fit"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </NativeSelect>
    );
  }

  /*
   * `step="any"` because the registry holds both integer keys
   * (`import.staleness_days`) and fractional ones — SPEC-017's
   * `wallets.drift_tolerance_pp` is a tolerance in percentage points, where
   * 0,5 is a legitimate setting for a wallet of four assets. A number input
   * defaults to `step="1"`, and the browser then rejects 0,5 with a message
   * this screen never wrote and cannot explain.
   *
   * Nothing is loosened by it: `setConfigValue` re-validates against the key's
   * own schema (BR-002-04), so a fraction typed into an integer key is refused
   * server-side with the key, the value and the permitted range named — which
   * is a better refusal than the browser's anyway.
   */
  return (
    <Input
      {...controlProps}
      name="value"
      type="number"
      step="any"
      defaultValue={typeof value === 'number' ? value : undefined}
      className="w-32"
    />
  );
}

function ParameterChoices({ parameterKey, value }: { parameterKey: ConfigKey; value: unknown }) {
  const entry = REGISTRY[parameterKey];

  // Only `reports.benchmarks` is both an array and user-settable
  // (`quotes.degradation_ladder`, the other array key, is deployment-only and
  // never reaches this component) — the `instanceof` narrows the element
  // schema properly rather than assuming which one it is.
  const element = entry.schema instanceof z.ZodArray ? (entry.schema.element as unknown) : null;
  const options = element instanceof z.ZodEnum ? (Object.values(element.enum) as string[]) : [];
  const selected = Array.isArray(value) ? (value as string[]) : [];

  return (
    <Cluster gap="md">
      {options.map((option) => (
        <Label key={option} htmlFor={`${parameterKey}-${option}`} className="text-sm font-normal">
          <Checkbox
            id={`${parameterKey}-${option}`}
            name="value"
            value={option}
            defaultChecked={selected.includes(option)}
          />
          {option}
        </Label>
      ))}
    </Cluster>
  );
}
