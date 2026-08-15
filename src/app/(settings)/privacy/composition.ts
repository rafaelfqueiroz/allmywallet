import { SystemClock } from '@/core/shared/clock';
import type { UserId } from '@/core/shared/ids';
import type { PrivacyDependencies } from '@/core/privacy/dependencies';
import type { AccountDeletionDependencies } from '@/core/privacy/delete-account';
import { DrizzleConsentRepository } from '@/adapters/db/consent-repository';
import { DrizzleAuditLogPort } from '@/adapters/db/audit-log';
import { DrizzlePersonalDataExportRepository } from '@/adapters/db/personal-data-export-repository';
import { DrizzleAccountDeletionRepository } from '@/adapters/db/account-deletion-repository';
import { LogNotificationAdapter } from '@/adapters/notifications/log-notification-adapter';
import { db } from '@/db/client';
import { withTenant } from '@/db/tenant';

/**
 * The composition root (AR-02) for `/privacy` and `/api/privacy/export/*`.
 * Every port is wired to its Drizzle adapter inside one `withTenant`
 * transaction, the same shape `withIngestionDeps`
 * (`src/app/(app)/import/composition.ts`) uses.
 */
const clock = new SystemClock();

export async function withPrivacyDeps<T>(
  userId: UserId,
  fn: (deps: PrivacyDependencies) => Promise<T>,
): Promise<T> {
  return withTenant(
    userId,
    async (tx) =>
      fn({
        consents: new DrizzleConsentRepository(tx, userId),
        auditLog: new DrizzleAuditLogPort(tx),
        exportData: new DrizzlePersonalDataExportRepository(tx),
        accountDeletion: new DrizzleAccountDeletionRepository(db),
        notifications: new LogNotificationAdapter(),
        clock,
      }),
    db,
  );
}

/**
 * Account deletion's request/purge functions take the narrower
 * `AccountDeletionDependencies` (see that type's own doc comment for why:
 * `users`/`sessions` carry no RLS, so there is no tenant transaction to open
 * here at all — a plain `Database` handle is correct, not a shortcut).
 */
export function buildAccountDeletionDeps(): AccountDeletionDependencies {
  return {
    accountDeletion: new DrizzleAccountDeletionRepository(db),
    auditLog: new DrizzleAuditLogPort(db),
    notifications: new LogNotificationAdapter(),
    clock,
  };
}
