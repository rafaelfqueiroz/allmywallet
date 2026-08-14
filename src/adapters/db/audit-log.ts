import { lt } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { auditLog } from '@/db/schema/config';
import type { Database } from '@/db/client';
import type { AuditEntry, AuditLogPort } from '@/core/privacy/ports';

/**
 * SPEC-004 — `audit_log` is declared shared/exempt (`src/db/shared-tables.ts`
 * `AUDIT_TABLES`), not RLS-scoped: BR-004-17 requires operator access to
 * personal data to be visible *across* tenants, which a `user_id`-keyed
 * policy would defeat. This adapter therefore takes the plain `Database`
 * handle, the same way `DrizzleUserRepository` does for `users` — never a
 * tenant transaction from `withTenant`, because there is no tenant context to
 * scope this table by.
 */
export class DrizzleAuditLogPort implements AuditLogPort {
  constructor(private readonly db: Database) {}

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
