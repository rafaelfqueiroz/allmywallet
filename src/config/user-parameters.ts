import type { UserId } from '@/core/shared/ids';
import { isErr } from '@/core/shared/result';
import { getEffectiveConfig } from '@/config/effective';
import { REGISTRY, type ConfigKey, type ConfigValue } from '@/config/registry';
import { setConfigValue } from '@/config/resolve';
import type { Tx } from '@/config/tx';

/**
 * SPEC-022 BR-022-37 — a screen's parameters are one form with one Salvar, so
 * they are saved together: the use case behind Preferências and each
 * Configurações › Parâmetros (SPEC-002 BR-002-03/04/07 still hold per key,
 * inside `setConfigValue`).
 *
 * - **All or nothing.** Every value is checked against its key's schema
 *   before anything is written; one refusal writes none, and every refused key
 *   is named so the form says why under that field (BR-022-21). A refusal
 *   during the writes — an unauthorised key — is returned as `refused`, and the
 *   caller runs this inside `withTenantRollbackOn`, which undoes the keys
 *   already written.
 * - **Only what the user changed is written.** A key is written when its value
 *   differs from the one the form was rendered with (`loaded`) *and* from the
 *   effective one. The first keeps the form from overwriting a change made
 *   elsewhere since it loaded — the eye toggle writes `ui.hide_values` on every
 *   page, and a Preferências save must not undo it (#238 review). The second
 *   keeps a default the user merely looked at from becoming a user-level
 *   override, with an audit row from a value to itself (BR-002-07).
 */
export interface UserParameterEntry {
  readonly key: ConfigKey;
  /** The submitted value, coerced to the schema's shape. */
  readonly value: unknown;
  /** What the form showed when it loaded; absent when the form did not say. */
  readonly loaded?: { readonly value: unknown };
}

export type SaveUserParametersOutcome =
  | { readonly status: 'saved'; readonly written: readonly ConfigKey[] }
  | { readonly status: 'refused'; readonly invalid: readonly ConfigKey[] };

/**
 * Whether two values say the same thing. A checkbox group posts its choices
 * in option order, not in the stored order, so an array compares as a set;
 * an empty number field (`undefined`) and a stored `null` are both "nothing".
 */
export function sameParameterValue(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown) =>
    JSON.stringify(
      Array.isArray(value) ? [...(value as unknown[])].map(String).sort() : (value ?? null),
    );
  return canonical(a) === canonical(b);
}

export async function saveUserParameters(
  tx: Tx,
  { userId, entries }: { readonly userId: UserId; readonly entries: readonly UserParameterEntry[] },
): Promise<SaveUserParametersOutcome> {
  const invalid = entries
    .filter(({ key, value }) => !REGISTRY[key].schema.safeParse(value).success)
    .map(({ key }) => key);
  if (invalid.length > 0) return { status: 'refused', invalid };

  const effective = await getEffectiveConfig(tx, { userId, keys: entries.map(({ key }) => key) });
  const current = new Map(effective.map((entry) => [entry.key, entry.value]));
  const written: ConfigKey[] = [];

  for (const { key, value, loaded } of entries) {
    if (loaded !== undefined && sameParameterValue(value, loaded.value)) continue;
    if (sameParameterValue(value, current.get(key))) continue;
    const result = await setConfigValue(tx, {
      key,
      level: 'user',
      // `setConfigValue` re-validates this against the registry schema. The
      // cast is unavoidable — `key`'s static type is the full `ConfigKey`
      // union, so its paired value type is a union too, and only the runtime
      // re-validation actually narrows it.
      value: value as ConfigValue<ConfigKey>,
      actor: { kind: 'user', userId },
      userId,
    });
    if (isErr(result)) return { status: 'refused', invalid: [key] };
    written.push(key);
  }
  return { status: 'saved', written };
}
