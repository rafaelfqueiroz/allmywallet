import { getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { REGISTRY, type ConfigKey } from '@/config/registry';
import { trySessionUserId } from '@/app/(settings)/preferences/session';
import { loadUserSettablePreferences } from '@/app/(settings)/preferences/data';
import { submitPreferenceForm } from '@/app/(settings)/preferences/actions';

/**
 * SPEC-002 — user-level preferences only (Out of Scope: a deployment-config
 * admin UI). Every field below is driven by the registry, not hand-listed:
 * add a key with `levels: [..., 'user']` in src/config/registry.ts and it
 * appears here with no other change (BR-002-01).
 */
export default async function PreferencesPage() {
  const t = await getTranslations('preferences');
  const userId = trySessionUserId();
  const preferences = await loadUserSettablePreferences();

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>

      {!userId ? (
        <p role="status" className="text-muted-foreground">
          {t('signedOut')}
        </p>
      ) : (
        <ul className="flex flex-col gap-6">
          {preferences.map((entry) => (
            <li key={entry.key} className="flex flex-col gap-2 border-b pb-6 last:border-0">
              <PreferenceField preferenceKey={entry.key} value={entry.value} />
            </li>
          ))}
        </ul>
      )}
    </main>
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

  return (
    <form action={action} className="flex flex-col gap-2">
      <label htmlFor={preferenceKey} className="font-medium">
        {t(`keys.${preferenceKey}.label` as Parameters<typeof t>[0])}
      </label>
      <p className="text-sm text-muted-foreground">
        {t(`keys.${preferenceKey}.description` as Parameters<typeof t>[0])}
      </p>
      <PreferenceInput preferenceKey={preferenceKey} value={value} />
      <button
        type="submit"
        className="w-fit rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent"
      >
        {t('save')}
      </button>
      {/* Range/description live on the registry entry, not repeated here — entry.range documents it for operators. */}
      <input type="hidden" name="_range" value={entry.range} />
    </form>
  );
}

function PreferenceInput({ preferenceKey, value }: { preferenceKey: ConfigKey; value: unknown }) {
  const entry = REGISTRY[preferenceKey];

  if (entry.schema instanceof z.ZodBoolean) {
    return (
      <input
        id={preferenceKey}
        name="value"
        type="checkbox"
        defaultChecked={value === true}
        className="h-4 w-4"
      />
    );
  }

  if (entry.schema instanceof z.ZodArray) {
    // Only `reports.benchmarks` is both an array and user-settable
    // (`quotes.degradation_ladder`, the other array key, is deployment-only
    // and never reaches this component) — the `instanceof` narrows the
    // element schema properly rather than assuming which one it is.
    const element = entry.schema.element as unknown;
    const options = element instanceof z.ZodEnum ? (Object.values(element.enum) as string[]) : [];
    const selected = Array.isArray(value) ? (value as string[]) : [];
    return (
      <BenchmarkCheckboxes preferenceKey={preferenceKey} options={options} selected={selected} />
    );
  }

  if (entry.schema instanceof z.ZodEnum) {
    const options = Object.values(entry.schema.enum) as string[];
    return (
      <select
        id={preferenceKey}
        name="value"
        defaultValue={typeof value === 'string' ? value : options[0]}
        className="w-fit rounded-md border px-2 py-1"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      id={preferenceKey}
      name="value"
      type="number"
      defaultValue={typeof value === 'number' ? value : undefined}
      className="w-32 rounded-md border px-2 py-1"
    />
  );
}

function BenchmarkCheckboxes({
  preferenceKey,
  options,
  selected,
}: {
  preferenceKey: ConfigKey;
  options: readonly string[];
  selected: readonly string[];
}) {
  return (
    <div className="flex gap-4">
      {options.map((option) => (
        <label
          key={option}
          className="flex items-center gap-1.5 text-sm"
          htmlFor={`${preferenceKey}-${option}`}
        >
          <input
            id={`${preferenceKey}-${option}`}
            name="value"
            type="checkbox"
            value={option}
            defaultChecked={selected.includes(option)}
          />
          {option}
        </label>
      ))}
    </div>
  );
}
