import type { DomainError } from '@/core/shared/domain-error';
import type { UserId } from '@/core/shared/ids';
import { type Result, err, ok } from '@/core/shared/result';
import type { PrivacyDependencies } from '@/core/privacy/dependencies';
import { PrivacyErrorCode, privacyError } from '@/core/privacy/errors';
import type { AccountDeletionStatus } from '@/core/privacy/ports';

/**
 * SPEC-004 BR-004-09/10 — self-service, irreversible account deletion.
 *
 * `deletionWindowDays` is a parameter, not a config lookup made from inside
 * this file: `retention.deletion_window_days` (SPEC-002 registry, default
 * 30, range 7–365) lives behind `resolveConfig`, which needs a database
 * transaction (AR-01 forbids `core/` from touching one) — exactly the same
 * shape `uploadExtractAction` already uses for `import.max_upload_mb`
 * (`src/app/(app)/import/actions.ts`). The composition root resolves the
 * value and passes it in.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface RequestAccountDeletionInput {
  readonly deletionWindowDays: number;
}

export interface RequestAccountDeletionOutcome {
  readonly requestedAt: Date;
  readonly purgeAt: Date;
}

/**
 * BR-004-09: "access is revoked immediately; all tenant-scoped data is
 * irreversibly removed within the configured window." Two things happen
 * synchronously here — sessions are revoked and the request is recorded —
 * and the actual purge happens later, in `purgeDueAccounts`, run by
 * `src/worker/handlers/account-deletion.ts`'s scheduled sweep.
 */
export async function requestAccountDeletion(
  deps: PrivacyDependencies,
  userId: UserId,
  input: RequestAccountDeletionInput,
): Promise<Result<RequestAccountDeletionOutcome, DomainError>> {
  const status = await deps.accountDeletion.findStatus(userId);
  if (status?.deletionRequestedAt) {
    return err(
      privacyError(PrivacyErrorCode.DELETION_ALREADY_REQUESTED, {
        requestedAt: status.deletionRequestedAt.toISOString(),
      }),
    );
  }

  const requestedAt = deps.clock.now();
  const purgeAt = new Date(requestedAt.getTime() + input.deletionWindowDays * MS_PER_DAY);

  // BR-004-09: "access is revoked immediately" — before the request is even
  // recorded, so a crash between the two calls fails safe (a user who can no
  // longer sign in, not one who can while a deletion is silently pending).
  await deps.accountDeletion.revokeSessions(userId);
  await deps.accountDeletion.markDeletionRequested(userId, requestedAt);

  await deps.auditLog.record({
    actor: userId,
    userId,
    action: 'account.deletion.requested',
    entityType: 'user',
    entityKey: userId,
    newValue: { purgeAt: purgeAt.toISOString() },
  });

  await deps.notifications.sendAccountDeletionRequested(userId, purgeAt);

  return ok({ requestedAt, purgeAt });
}

export async function getAccountDeletionStatus(
  deps: PrivacyDependencies,
  userId: UserId,
): Promise<AccountDeletionStatus | null> {
  return deps.accountDeletion.findStatus(userId);
}

export interface PurgeAccountsOutcome {
  readonly purged: readonly UserId[];
  readonly failed: readonly { readonly userId: UserId; readonly message: string }[];
}

/**
 * SPEC-004 BR-004-09/10 — the scheduled half. `deletionWindowDays` is the
 * same resolved-by-the-caller shape `requestAccountDeletion` uses (see that
 * function's doc comment) — the worker handler resolves
 * `retention.deletion_window_days` once per sweep and passes it in, so this
 * function does the `asOf - windowDays` arithmetic itself and hands the
 * adapter an already-computed cutoff rather than a config key it would have
 * no way to look up (AR-01).
 *
 * `purgeUser` is a single irreversible `DELETE FROM users WHERE id = ...`,
 * and AR-27's `ON DELETE CASCADE` is what makes that one statement complete
 * for every tenant-scoped table without a per-table cleanup list to maintain
 * here.
 *
 * One account's failure does not stop the sweep from reaching the rest —
 * `failed` surfaces it to the caller (the worker handler logs it, AR-39: code
 * and structural context only) rather than a thrown error losing every
 * account after the one that failed.
 */
export async function purgeDueAccounts(
  deps: PrivacyDependencies,
  asOf: Date,
  deletionWindowDays: number,
): Promise<PurgeAccountsOutcome> {
  const cutoff = new Date(asOf.getTime() - deletionWindowDays * MS_PER_DAY);
  const due = await deps.accountDeletion.findDueForPurge(cutoff);
  const purged: UserId[] = [];
  const failed: { userId: UserId; message: string }[] = [];

  for (const userId of due) {
    try {
      // Notified *before* the purge, deliberately: `purgeUser` deletes the
      // `users` row, and with it the only place an email address for this
      // account lives (`users.email` — nothing else in the schema carries
      // it). A real `NotificationPort` adapter has no address left to send to
      // once this account is gone, so "confirmed by email" has to happen
      // while the account still exists, one statement ahead of the delete
      // that makes it irreversible.
      await deps.notifications.sendAccountDeletionCompleted(userId);
      await deps.accountDeletion.purgeUser(userId);
      // Written *after* the purge succeeds and deliberately carries no FK
      // (src/db/schema/config.ts's `auditLog` comment) — this row is the one
      // piece of evidence that the account ever existed and was deleted.
      await deps.auditLog.record({
        actor: 'system',
        userId,
        action: 'account.deletion.purged',
        entityType: 'user',
        entityKey: userId,
      });
      purged.push(userId);
    } catch (error) {
      failed.push({ userId, message: error instanceof Error ? error.message : 'unknown error' });
    }
  }

  return { purged, failed };
}
