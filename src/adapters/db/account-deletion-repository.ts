import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { sessions, users } from '@/db/schema/users';
import type { Database } from '@/db/client';
import { UserId } from '@/core/shared/ids';
import type { AccountDeletionPort, AccountDeletionStatus } from '@/core/privacy/ports';

/**
 * SPEC-004 BR-004-09/10. Like `DrizzleUserRepository`, this legitimately
 * queries `db` directly rather than through `withTenant`: `users` is the
 * tenant root and carries no RLS policy at all (SPEC-001), and `sessions` is
 * declared auth substrate for the same reason
 * (`src/db/shared-tables.ts`'s `AUTH_SUBSTRATE_TABLES`) — resolving *who* a
 * session belongs to has to run before any `app.user_id` could be set.
 *
 * `purgeUser` is the one place in this spec that deletes a row with no
 * `WHERE user_id = current_setting(...)` guard around it, and that is
 * correct rather than a bypass: there is no tenant context to guard with
 * here, because deleting *is* the operation, and everything it cascades to
 * (AR-27) is scoped by the ordinary `user_id` foreign key each of those
 * tables already carries.
 */
export class DrizzleAccountDeletionRepository implements AccountDeletionPort {
  constructor(private readonly db: Database) {}

  async findStatus(userId: UserId): Promise<AccountDeletionStatus | null> {
    const [row] = await this.db
      .select({ id: users.id, deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, userId));
    if (!row) return null;
    return { userId: UserId.of(row.id), deletionRequestedAt: row.deletedAt };
  }

  async revokeSessions(userId: UserId): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.userId, userId));
  }

  /** SPEC-001's `users.deletedAt` — "a soft marker... so #7 has somewhere to record 'deletion requested'" (`src/db/schema/users.ts`). Reused rather than a second column. */
  async markDeletionRequested(userId: UserId, requestedAt: Date): Promise<void> {
    await this.db.update(users).set({ deletedAt: requestedAt }).where(eq(users.id, userId));
  }

  async clearDeletionRequest(userId: UserId): Promise<void> {
    await this.db.update(users).set({ deletedAt: null }).where(eq(users.id, userId));
  }

  async findDueForPurge(cutoff: Date): Promise<readonly UserId[]> {
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(isNotNull(users.deletedAt), lte(users.deletedAt, cutoff)));
    return rows.map((row) => UserId.of(row.id));
  }

  /**
   * Irreversible. AR-27: every tenant-scoped table's `ON DELETE CASCADE` from
   * `users` is what makes this one statement complete —
   * `tests/isolation/deletion-cascade.test.ts` is the CI gate that keeps that
   * true as new tables are added.
   */
  async purgeUser(userId: UserId): Promise<void> {
    await this.db.delete(users).where(eq(users.id, userId));
  }
}
