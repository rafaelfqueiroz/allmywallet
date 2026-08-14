import { lt } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { auditLog } from '@/db/schema/config';
import type { Database } from '@/db/client';
import type { Tx } from '@/db/tenant';
import type { AuditEntry, AuditLogPort } from '@/core/privacy/ports';

/**
 * SPEC-004 — `audit_log` is declared shared/exempt (`src/db/shared-tables.ts`
 * `AUDIT_TABLES`), not RLS-scoped: BR-004-17 requires operator access to
 * personal data to be visible *across* tenants, which a `user_id`-keyed
 * policy would defeat. This adapter accepts either the plain `Database`
 * handle (the same way `DrizzleUserRepository` does for `users` — no tenant
 * context needed, since this table carries no policy to satisfy) **or** an
 * already-open `withTenant` transaction, so a composition root writing an
 * audit entry alongside a tenant-scoped write (`grantConsent`,
 * `requestAccountDeletion`) can do so on the *same* connection, atomically
 * with it — the same reasoning `setConfigValue`'s own `audit_log` write uses
 * (`src/config/resolve.ts`). `src/worker/handlers/account-deletion.ts`'s
 * sweep, which has no single tenant to open a transaction for, passes the
 * plain `Database` instead.
 */
export class DrizzleAuditLogPort implements AuditLogPort {
  constructor(private readonly db: Database | Tx) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.db.insert(auditLog).values({
      id: uuidv7(),
      actor: entry.actor,
      userId: entry.userId,
      action: entry.action,
      entityType: entry.entityType,
      entityKey: entry.entityKey,
      previousValue: entry.previousValue ?? null,
      newValue: entry.newValue ?? null,
      ipHash: entry.ipHash ?? null,
    });
  }

  /**
   * SPEC-004 BR-004-15: `retention.audit_months` bounds how long a row
   * lives. `cutoff` is resolved by the caller (the worker sweep resolves the
   * config key and does the date math), so this is a single `DELETE ...
   * WHERE created_at < cutoff` with no config knowledge of its own — the same
   * shape `AccountDeletionPort.findDueForPurge` uses.
   */
  async purgeOlderThan(cutoff: Date): Promise<number> {
    const deleted = await this.db.delete(auditLog).where(lt(auditLog.createdAt, cutoff)).returning({
      id: auditLog.id,
    });
    return deleted.length;
  }
}
