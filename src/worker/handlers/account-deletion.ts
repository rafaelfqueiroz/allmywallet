import { db as globalDb, type Database } from '@/db/client';
import { resolveConfig } from '@/config/resolve';
import { SystemClock, type Clock } from '@/core/shared/clock';
import { hashUserId, logger } from '@/lib/logger';
import type { AccountDeletionDependencies } from '@/core/privacy/delete-account';
import { purgeDueAccounts } from '@/core/privacy/delete-account';
import { DrizzleAccountDeletionRepository } from '@/adapters/db/account-deletion-repository';
import { DrizzleAuditLogPort } from '@/adapters/db/audit-log';
import { LogNotificationAdapter } from '@/adapters/notifications/log-notification-adapter';

/**
 * SPEC-004 — the two scheduled privacy sweeps. AR-04: thin entrypoints; the
 * actual rules live in `core/privacy/`.
 *
 * Both handlers resolve their config key with **no tenant context**
 * (`resolveConfig(key, { db })`, no `userId`) — `retention.deletion_window_days`
 * and `retention.audit_months` are `levels: ['deployment']`-only registry
 * entries (SPEC-002), so there is no per-user override to look up in the
 * first place, and a sweep spanning every account has no single tenant to
 * scope a lookup by even if there were.
 */

export interface AccountDeletionHandlerDeps {
  readonly database: Database;
  readonly clock: Clock;
}

function resolveDeps(overrides?: Partial<AccountDeletionHandlerDeps>): AccountDeletionHandlerDeps {
  return {
    database: overrides?.database ?? globalDb,
    clock: overrides?.clock ?? new SystemClock(),
  };
}

function buildPrivacyDeps(database: Database, clock: Clock): AccountDeletionDependencies {
  return {
    accountDeletion: new DrizzleAccountDeletionRepository(database),
    auditLog: new DrizzleAuditLogPort(database),
    notifications: new LogNotificationAdapter(),
    clock,
  };
}

/**
 * SPEC-004 BR-004-09/10 — `account.deletion-sweep`. Runs daily
 * (`src/worker/registrations.ts`); AR-19: idempotent, because an account
 * `purgeDueAccounts` already purged is no longer returned by
 * `findDueForPurge` on the next run — there is no "already deleted" state to
 * re-trigger.
 */
export async function handleAccountDeletionSweep(
  overrides?: Partial<AccountDeletionHandlerDeps>,
): Promise<void> {
  const deps = resolveDeps(overrides);
  const windowDays = (
    await resolveConfig('retention.deletion_window_days', { db: deps.database })
  ).value;

  const privacyDeps = buildPrivacyDeps(deps.database, deps.clock);
  const outcome = await purgeDueAccounts(privacyDeps, deps.clock.now(), windowDays);

  // AR-39/BR-004-04: hashed ids and counts only — never an email or name.
  logger.info(
    {
      queue: 'account.deletion-sweep',
      purgedCount: outcome.purged.length,
      failedCount: outcome.failed.length,
    },
    'SPEC-004 BR-004-09/10: account deletion sweep complete',
  );
  for (const failure of outcome.failed) {
    logger.error(
      { queue: 'account.deletion-sweep', userIdHash: hashUserId(failure.userId) },
      'SPEC-004: account purge failed — will retry on the next sweep',
    );
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Calendar months are not a fixed number of days; 30.44 is the average Gregorian month length — adequate for a retention *floor* that only needs to be roughly a year, never exact to the day. */
const AVERAGE_DAYS_PER_MONTH = 30.44;

/**
 * SPEC-004 BR-004-15 — `privacy.audit-retention-sweep`. `retention.audit_months`
 * (default 12, range 1–120) bounds how long an `audit_log` row survives.
 */
export async function handleAuditRetentionSweep(
  overrides?: Partial<AccountDeletionHandlerDeps>,
): Promise<void> {
  const deps = resolveDeps(overrides);
  const months = (await resolveConfig('retention.audit_months', { db: deps.database })).value;
  const cutoff = new Date(
    deps.clock.now().getTime() - months * AVERAGE_DAYS_PER_MONTH * MS_PER_DAY,
  );

  const auditLog = new DrizzleAuditLogPort(deps.database);
  const purgedCount = await auditLog.purgeOlderThan(cutoff);

  logger.info(
    { queue: 'privacy.audit-retention-sweep', purgedCount, cutoff: cutoff.toISOString() },
    'SPEC-004 BR-004-15: audit_log retention sweep complete',
  );
}
