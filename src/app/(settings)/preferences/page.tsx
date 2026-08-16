import type * as React from 'react';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { REGISTRY, type ConfigKey } from '@/config/registry';
import { trySessionUserId } from '@/app/(settings)/preferences/session';
import { loadUserSettablePreferences } from '@/app/(settings)/preferences/data';
import { submitPreferenceForm } from '@/app/(settings)/preferences/actions';
import { PageShell } from '@/components/patterns/page-shell';
import { EmptyState } from '@/components/patterns/empty-state';
import { Field } from '@/components/patterns/field';
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
 * SPEC-002 — user-level preferences only (Out of Scope: a deployment-config
 * admin UI). Every field below is driven by the registry, not hand-listed:
 * add a key with `levels: [..., 'user']` in src/config/registry.ts and it
 * appears here with no other change (BR-002-01).
 */

/**
 * Never prerendered, and this is a tenant-isolation requirement rather than a
 * build detail. The page renders one account's own preferences; a statically
 * generated copy would be built once — from whatever session existed at build
 * time, or none — and then served to every user from the cache. That is
 * cross-tenant leakage arriving through the CDN rather than through a missing
 * WHERE clause, and no RLS policy can catch it, because the query never runs
 * again.
 *
 * It also happens to be why `pnpm build` failed: prerendering ran the config
 * lookup at build time, with no database to reach.
 */
export const dynamic = 'force-dynamic';

export default async function PreferencesPage() {
  const t = await getTranslations('preferences');
  const userId = trySessionUserId();
  const preferences = await loadUserSettablePreferences();

  return (
    <PageShell width="narrow" title={t('title')} description={t('description')}>
      {!userId ? (
        <EmptyState title={t('signedOut')} />
      ) : (
        <List gap="lg">
          {preferences.map((entry) => (
            <ListItem key={entry.key} separated>
              <PreferenceField preferenceKey={entry.key} value={entry.value} />
            </ListItem>
          ))}
        </List>
      )}
    </PageShell>
  );
}

async function PreferenceField({
  preferenceKey,
  value,
}: {
  preferenceKey: ConfigKey;
  value: unknown;
}) {
  const t = await getTranslations('preferences');
  const entry = REGISTRY[preferenceKey];
  const action = submitPreferenceForm.bind(null, preferenceKey);

  const label = t(`keys.${preferenceKey}.label` as Parameters<typeof t>[0]);
  const description = t(`keys.${preferenceKey}.description` as Parameters<typeof t>[0]);

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
              <PreferenceInput preferenceKey={preferenceKey} value={value} />
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
        <Field id={preferenceKey} label={label} hint={description}>
          <PreferenceControl preferenceKey={preferenceKey} value={value} />
        </Field>
        <Button type="submit">{t('save')}</Button>
        {/* Range/description live on the registry entry, not repeated here — entry.range documents it for operators. */}
        <input type="hidden" name="_range" value={entry.range} />
      </Stack>
    </form>
  );
}

/** The single-control cases, which `Field` can label and describe. */
function PreferenceControl({
  preferenceKey,
  value,
  ...controlProps
}: {
  preferenceKey: ConfigKey;
  /** The stored config value, which is `unknown` until the schema narrows it —
   * deliberately shadowing the DOM `value` attribute, which this never sets. */
  value: unknown;
} & Omit<React.ComponentProps<'input'>, 'value'>) {
  const entry = REGISTRY[preferenceKey];

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

  return (
    <Input
      {...controlProps}
      name="value"
      type="number"
      defaultValue={typeof value === 'number' ? value : undefined}
      className="w-32"
    />
  );
}

function PreferenceInput({ preferenceKey, value }: { preferenceKey: ConfigKey; value: unknown }) {
  const entry = REGISTRY[preferenceKey];

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
        <Label key={option} htmlFor={`${preferenceKey}-${option}`} className="text-sm font-normal">
          <Checkbox
            id={`${preferenceKey}-${option}`}
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
