import { getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { REGISTRY, type ConfigKey, type ParameterSurface } from '@/config/registry';
import { loadParameters } from '@/app/parameter-data';
import { saveParameterAction } from '@/app/parameter-actions';
import { ParameterField, type ParameterControl } from '@/app/parameter-field';
import { Section } from '@/components/patterns/section';
import { List, ListItem } from '@/components/layout/list';

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
  const t = await getTranslations('parameters');
  const parameters = await loadParameters(surface);

  return (
    <List gap="lg">
      {parameters.map(({ key, value }) => (
        <ListItem key={key} separated>
          <ParameterField
            id={key}
            label={t(`keys.${key}.label` as Parameters<typeof t>[0])}
            hint={t(`keys.${key}.description` as Parameters<typeof t>[0])}
            invalidMessage={invalidMessage(key, t)}
            control={controlFor(key, value, t)}
            action={saveParameterAction.bind(null, key)}
          />
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

type Translate = Awaited<ReturnType<typeof getTranslations<'parameters'>>>;

function optionLabel(key: ConfigKey, option: string, t: Translate): string {
  return t(`keys.${key}.options.${option}` as Parameters<typeof t>[0]);
}

/**
 * The registry's own schema decides the control, so a new key of an existing
 * shape needs nothing here. Only numbers, booleans, enums and arrays of enums
 * are user-level today; an object key stays deployment-only
 * (`notifications.quiet_hours` says why).
 */
function controlFor(key: ConfigKey, value: unknown, t: Translate): ParameterControl {
  const schema = REGISTRY[key].schema as unknown;

  if (schema instanceof z.ZodBoolean) return { kind: 'boolean', value: value === true };

  if (schema instanceof z.ZodEnum) {
    const options = (Object.values(schema.enum) as string[]).map((option) => ({
      value: option,
      label: optionLabel(key, option, t),
    }));
    return {
      kind: 'enum',
      value: typeof value === 'string' ? value : (options[0]?.value ?? ''),
      options,
    };
  }

  if (schema instanceof z.ZodArray) {
    const element = schema.element as unknown;
    const values = element instanceof z.ZodEnum ? (Object.values(element.enum) as string[]) : [];
    return {
      kind: 'choices',
      value: Array.isArray(value) ? (value as string[]) : [],
      options: values.map((option) => ({ value: option, label: optionLabel(key, option, t) })),
    };
  }

  return { kind: 'number', value: typeof value === 'number' ? value : undefined };
}

/**
 * What a refused save says (BR-022-21), in pt-BR: the bounds a number key's
 * schema permits, read from the schema rather than restated. The registry's
 * `range` string is for operators and is English.
 */
function invalidMessage(key: ConfigKey, t: Translate): string {
  const schema = REGISTRY[key].schema as unknown;
  if (
    schema instanceof z.ZodNumber &&
    schema.minValue !== null &&
    schema.maxValue !== null &&
    Number.isFinite(schema.minValue) &&
    Number.isFinite(schema.maxValue)
  ) {
    return t('invalidBetween', { min: schema.minValue, max: schema.maxValue });
  }
  return t('invalid');
}
