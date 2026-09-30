import { sql } from 'drizzle-orm';
import { db, type Database } from '@/db/client';
import type { UserId } from '@/core/shared/ids';
import type { Result } from '@/core/shared/result';

/**
 * ARCHITECTURE §5 / SPEC-003 BR-003-04: tenant context is set from the
 * authenticated session at the start of a transaction, never from a
 * client-supplied parameter. `withTenant` is the *only* sanctioned entry
 * point for a tenant-scoped query — a raw `db.` call in a request path is a
 * defect, not a style preference (AR-11).
 *
 * Derived from `Database['transaction']` itself rather than naming Drizzle's
 * internal transaction generic directly, so this stays correct across
 * drizzle-orm versions without tracking their type names.
 */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * AR-11/AR-13: runs `fn` inside a transaction with `app.user_id` set via
 * `set_config(..., true)` — the third argument is what makes the setting
 * transaction-scoped rather than session-scoped. That matters specifically
 * because the pool is shared: without `true`, a connection released back to
 * the pool after this transaction would carry tenant A's context into
 * whichever request the pool hands that connection to next. Session-level
 * `SET` is prohibited for exactly this reason.
 *
 * A query that runs outside `withTenant` is not merely unfiltered — it fails.
 * Every tenant table's policy reads `current_setting('app.user_id')` with no
 * default, so a connection that never called `set_config` raises
 * "unrecognized configuration parameter" rather than returning every tenant's
 * rows (TS-16). RLS fails closed.
 */
export async function withTenant<T>(
  userId: UserId,
  fn: (tx: Tx) => Promise<T>,
  database: Database = db,
): Promise<T> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}

/**
 * An expected refusal still has to leave Drizzle through a thrown value: a
 * transaction callback that merely returns an error commits every write made
 * before that return. The instance is private to this module and compared by
 * identity, so a genuine exception — including one with the same message —
 * can never be mistaken for an expected outcome.
 */
class ExpectedTransactionRefusal<T> extends Error {
  constructor(readonly value: T) {
    super('Expected transaction refusal');
    this.name = 'ExpectedTransactionRefusal';
  }
}

/**
 * Runs a tenant callback atomically when the callback reports expected
 * failures as values rather than exceptions.
 *
 * SPEC-010 BR-010-05 / SPEC-006 BR-006-15: a late allocation or ledger
 * refusal must undo writes already made in the same operation while preserving
 * the structured refusal the caller needs to explain. Genuine faults continue
 * to throw and successful values commit normally.
 */
export async function withTenantRollbackOn<T>(
  userId: UserId,
  fn: (tx: Tx) => Promise<T>,
  shouldRollback: (value: T) => boolean,
  database: Database = db,
): Promise<T> {
  let refusal: ExpectedTransactionRefusal<T> | undefined;
  try {
    return await withTenant(
      userId,
      async (tx) => {
        const value = await fn(tx);
        if (shouldRollback(value)) {
          refusal = new ExpectedTransactionRefusal(value);
          throw refusal;
        }
        return value;
      },
      database,
    );
  } catch (error) {
    if (refusal !== undefined && error === refusal) return refusal.value;
    throw error;
  }
}

/** Result-aware form used by core use-case composition roots (AR-36). */
export async function withTenantResult<T, E>(
  userId: UserId,
  fn: (tx: Tx) => Promise<Result<T, E>>,
  database: Database = db,
): Promise<Result<T, E>> {
  return withTenantRollbackOn(userId, fn, (result) => !result.ok, database);
}

/**
 * A read-only sweep across many tenants, in **one** transaction and on one
 * pooled connection.
 *
 * `withTenant` per tenant is the right shape for a request and the wrong one
 * for a sweep. `quotes.poll` fires every five minutes through market hours
 * and derives its polling set from every account's positions (SPEC-008
 * BR-008-08), so the per-tenant form meant a `BEGIN` / `set_config` /
 * `SELECT` / `COMMIT` round trip **per account, per tick** — five hundred
 * accounts is five hundred transactions every five minutes on a two-vCPU box,
 * to compute a set the free tier caps at roughly fifty assets. The cost grew
 * with signups; the answer did not.
 *
 * This keeps tenant context in this file — the one module allowed to set it
 * (AR-11) — and uses the identical mechanism: `set_config(..., true)`, so the
 * setting is transaction-scoped and cannot escape onto a pooled connection
 * (AR-13). Each iteration overwrites the previous tenant's value, and the
 * whole thing is discarded at `COMMIT`.
 *
 * **Reads only.** Every tenant in the sweep shares one transaction, so one
 * tenant's failed write would roll back every other tenant's — which is
 * exactly why `opportunity.evaluate` and `valuation.snapshot`, both of which
 * write, keep their per-tenant `withTenant` and their per-tenant failure
 * isolation. Use this only where the result is a fact being *gathered*.
 */
export async function withEachTenant<T>(
  userIds: readonly UserId[],
  fn: (tx: Tx, userId: UserId) => Promise<T>,
  database: Database = db,
): Promise<readonly T[]> {
  if (userIds.length === 0) return [];
  return database.transaction(async (tx) => {
    const results: T[] = [];
    for (const userId of userIds) {
      await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
      results.push(await fn(tx, userId));
    }
    return results;
  });
}
