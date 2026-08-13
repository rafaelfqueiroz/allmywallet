'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isErr } from '@/core/shared/result';
import { db } from '@/db/client';
import { REGISTRY, USER_SETTABLE_KEYS, type ConfigKey, type ConfigValue } from '@/config/registry';
import { setConfigValue } from '@/config/resolve';
import { requireSessionUserId } from '@/app/(settings)/preferences/session';

/**
 * SPEC-002 — the only interface surface this spec ships (the spec's Out of
 * Scope explicitly excludes a deployment-config admin UI; only per-user
 * preferences get one). Every key here is user-settable by construction —
 * `USER_SETTABLE_KEYS` is derived from the registry, never hand-maintained.
 */

const UserSettableKey = z.custom<ConfigKey>(
  (value): value is ConfigKey =>
    typeof value === 'string' && (USER_SETTABLE_KEYS as readonly string[]).includes(value),
  'not a user-settable configuration key',
);

/**
 * Coerces a raw form field to the shape each key's Zod schema expects.
 * `formData` values are always strings (or File, never here) — this is the
 * one place that bridges HTML form semantics to the registry's real types.
 */
function coerceFormValue(key: ConfigKey, formData: FormData): unknown {
  const entry = REGISTRY[key];
  if (entry.schema instanceof z.ZodBoolean) {
    return formData.get('value') === 'on';
  }
  if (entry.schema instanceof z.ZodArray) {
    return formData.getAll('value');
  }
  const raw = formData.get('value');
  if (raw === null || raw === '') return undefined;
  const asNumber = Number(raw);
  return Number.isNaN(asNumber) ? raw : asNumber;
}

export interface SavePreferenceState {
  readonly status: 'idle' | 'saved' | 'error';
  readonly errorCode?: string;
}

/**
 * AR-32: validates input with Zod at the boundary, resolves the session, and
 * calls exactly one operation — `setConfigValue`, which itself re-validates
 * the coerced value against the key's own schema (BR-002-04) and authorizes
 * the write (BR-002-03) before anything reaches the database.
 */
export async function saveUserPreference(
  key: unknown,
  formData: FormData,
): Promise<SavePreferenceState> {
  const parsedKey = UserSettableKey.safeParse(key);
  if (!parsedKey.success) return { status: 'error', errorCode: 'VALIDATION_FAILED' };

  const userId = requireSessionUserId();
  const value = coerceFormValue(parsedKey.data, formData);

  // TODO(#6): pass the transaction `withTenant(userId, ...)` supplies once it
  // exists, rather than the plain `db` handle — see src/config/tx.ts.
  const result = await setConfigValue(db, {
    key: parsedKey.data,
    level: 'user',
    // `setConfigValue` re-validates this against the registry schema; an
    // invalid coercion is reported as INVALID_VALUE, not thrown here. The
    // cast is unavoidable — `parsedKey.data`'s static type is the full
    // `ConfigKey` union, so its paired value type is a union too, and only
    // the runtime re-validation actually narrows it.
    value: value as ConfigValue<ConfigKey>,
    actor: { kind: 'user', userId },
    userId,
  });

  if (isErr(result)) return { status: 'error', errorCode: result.error.code };

  revalidatePath('/preferences');
  return { status: 'saved' };
}

/**
 * A `<form action={...}>` bound directly from a Server Component (page.tsx)
 * must itself be a Server Action returning `void` — React's form-action type
 * has no room for `saveUserPreference`'s result. This is the thin adapter
 * that boundary requires; `saveUserPreference` stays the testable unit with
 * a real return value.
 */
export async function submitPreferenceForm(key: unknown, formData: FormData): Promise<void> {
  await saveUserPreference(key, formData);
}
