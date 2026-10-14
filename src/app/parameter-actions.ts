'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import {
  PARAMETER_SURFACES,
  REGISTRY,
  keysOnSurface,
  type ConfigKey,
  type ParameterSurface,
} from '@/config/registry';
import { saveUserParameters } from '@/config/user-parameters';
import { loadedFieldName } from '@/app/parameter-names';
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

export interface SaveParametersState {
  readonly status: 'idle' | 'saved' | 'error';
  /** The keys whose value was refused — each said under its own field. */
  readonly invalid?: readonly ConfigKey[];
}

function loadedValue(key: ConfigKey, formData: FormData): { value: unknown } | undefined {
  const raw = formData.get(loadedFieldName(key));
  if (typeof raw !== 'string') return undefined;
  try {
    return { value: JSON.parse(raw) as unknown };
  } catch {
    return undefined;
  }
}

/**
 * One surface's parameters, saved by one form (SPEC-022 BR-022-37: a form has
 * one footer and one Salvar). AR-32: the boundary — the surface checked
 * against the registry's list, the session resolved, the fields coerced — and
 * one use case, `saveUserParameters`, which decides what is written and is
 * all or nothing; `withTenantRollbackOn` undoes a partial write it refuses.
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
  const entries = keys.map((key) => {
    const loaded = loadedValue(key, formData);
    return {
      key,
      value: coerceFormValue(key, formData),
      ...(loaded !== undefined ? { loaded } : {}),
    };
  });

  // AR-11: a user-level write reads `config_overrides` for the audit's
  // previous value, and that RLS policy raises 22P02 outside `withTenant`
  // rather than failing closed.
  const outcome = await withTenantRollbackOn(
    userId,
    (tx) => saveUserParameters(tx, { userId, entries }),
    (result) => result.status === 'refused',
    db,
  );
  if (outcome.status === 'refused') return { status: 'error', invalid: outcome.invalid };

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
