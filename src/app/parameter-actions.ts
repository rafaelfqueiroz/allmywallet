'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isErr } from '@/core/shared/result';
import { db } from '@/db/client';
import { getEffectiveConfig } from '@/config/effective';
import {
  PARAMETER_SURFACES,
  REGISTRY,
  keysOnSurface,
  type ConfigKey,
  type ConfigValue,
  type ParameterSurface,
} from '@/config/registry';
import { setConfigValue } from '@/config/resolve';
import { withTenantRollbackOn } from '@/db/tenant';
import { requireUserId } from '@/lib/session';

/**
 * SPEC-002 — the only interface surface this spec ships (the spec's Out of
 * Scope explicitly excludes a deployment-config admin UI; only per-user
 * preferences get one). Every key here is user-settable by construction —
 * `USER_SETTABLE_KEYS` is derived from the registry, never hand-maintained.
 *
 * Shared by every screen `ParameterForm` renders on (SPEC-022 BR-022-13):
 * Preferências and each Configurações section save through the same write,
 * whatever surface the key is on. Only a key on the posted surface is read —
 * and `keysOnSurface` holds only user-settable keys, derived from the
 * registry, never hand-maintained.
 */

/**
 * Coerces one key's raw form field to the shape its Zod schema expects. The
 * field is named by the key. `formData` values are always strings (or File,
 * never here) — this is the one place that bridges HTML form semantics to the
 * registry's real types.
 */
function coerceFormValue(key: ConfigKey, formData: FormData): unknown {
  const entry = REGISTRY[key];
  if (entry.schema instanceof z.ZodBoolean) {
    return formData.get(key) === 'on';
  }
  if (entry.schema instanceof z.ZodArray) {
    return formData.getAll(key);
  }
  const raw = formData.get(key);
  if (raw === null || raw === '') return undefined;
  const asNumber = Number(raw);
  return Number.isNaN(asNumber) ? raw : asNumber;
}

/**
 * Whether a submitted value says the same as the effective one. A checkbox
 * group posts its choices in option order, not in the stored order, so an
 * array compares as a set.
 */
function sameValue(submitted: unknown, effective: unknown): boolean {
  const canonical = (value: unknown) =>
    JSON.stringify(Array.isArray(value) ? [...(value as unknown[])].map(String).sort() : value);
  return canonical(submitted) === canonical(effective);
}

export interface SaveParametersState {
  readonly status: 'idle' | 'saved' | 'error';
  /** The keys whose value the schema refused — each said under its own field. */
  readonly invalid?: readonly ConfigKey[];
}

/**
 * One surface's parameters, saved by one form (SPEC-022 BR-022-37: a form has
 * one footer and one Salvar).
 *
 * AR-32: validates input with Zod at the boundary, resolves the session, and
 * calls exactly one operation per changed key — `setConfigValue`, which itself
 * re-validates the coerced value against the key's own schema (BR-002-04) and
 * authorizes the write (BR-002-03) before anything reaches the database.
 *
 * **All or nothing.** Every value is checked against its schema first; one
 * refusal writes none, and each refused key is named so the form says why
 * under that field (BR-022-21). The writes then share one transaction, so a
 * late refusal rolls back the keys already written.
 *
 * **Only a changed value is written.** The form posts every key on the
 * surface; writing the unchanged ones would turn each default the user merely
 * looked at into a user-level override, and audit a "change" from a value to
 * itself (BR-002-07).
 */
export async function saveParameters(
  surface: unknown,
  formData: FormData,
): Promise<SaveParametersState> {
  if (!(PARAMETER_SURFACES as readonly unknown[]).includes(surface)) return { status: 'error' };
  const keys = keysOnSurface(surface as ParameterSurface);

  // SPEC-001 BR-001-08 / AR-12: the tenant is the verified session's, and
  // nothing in `formData` is ever read as one.
  const userId = await requireUserId();
  const submitted = keys.map((key) => ({ key, value: coerceFormValue(key, formData) }));
  const invalid = submitted
    .filter(({ key, value }) => !REGISTRY[key].schema.safeParse(value).success)
    .map(({ key }) => key);
  if (invalid.length > 0) return { status: 'error', invalid };

  // AR-11: a user-level write reads `config_overrides` for the audit's
  // previous value, and that RLS policy raises 22P02 outside `withTenant`
  // rather than failing closed. One transaction also keeps every upsert and
  // its BR-002-07 audit row atomic.
  const outcome = await withTenantRollbackOn(
    userId,
    async (tx): Promise<SaveParametersState> => {
      const effective = await getEffectiveConfig(tx, { userId, keys });
      const current = new Map(effective.map((entry) => [entry.key, entry.value]));
      for (const { key, value } of submitted) {
        if (sameValue(value, current.get(key))) continue;
        const result = await setConfigValue(tx, {
          key,
          level: 'user',
          // `setConfigValue` re-validates this against the registry schema.
          // The cast is unavoidable — `key`'s static type is the full
          // `ConfigKey` union, so its paired value type is a union too, and
          // only the runtime re-validation actually narrows it.
          value: value as ConfigValue<ConfigKey>,
          actor: { kind: 'user', userId },
          userId,
        });
        if (isErr(result)) return { status: 'error', invalid: [key] };
      }
      return { status: 'saved' };
    },
    (state) => state.status === 'error',
    db,
  );
  if (outcome.status === 'error') return outcome;

  // The layout, not just this page: `ui.theme` and `ui.hide_values` are read
  // by the signed-in frame (its theme sync, the eye toggle and the charts'
  // masking context), which a page-scoped revalidation leaves stale.
  revalidatePath('/', 'layout');
  return { status: 'saved' };
}

/**
 * The shape `useActionState` calls: `ParameterFields` binds the surface,
 * React supplies the previous state. `saveParameters` stays the testable
 * unit; this only adapts its argument order.
 */
export async function saveParametersAction(
  surface: unknown,
  _previous: SaveParametersState,
  formData: FormData,
): Promise<SaveParametersState> {
  return saveParameters(surface, formData);
}
