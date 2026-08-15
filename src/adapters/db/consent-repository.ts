import { and, eq } from 'drizzle-orm';
import { consents } from '@/db/schema/privacy';
import type { Tx } from '@/db/tenant';
import { ConsentId, type UserId } from '@/core/shared/ids';
import type { ConsentPurpose, ConsentRecord, ConsentRepository } from '@/core/privacy/ports';

/**
 * SPEC-004 — `consents` is tenant-scoped and `FORCE`-RLS'd
 * (`src/db/migrations/0010_pink_kat_farrell.sql`), so this repository — like
 * `DrizzleTransactionRepository`/`DrizzleWalletRepository` — must always be
 * constructed from a transaction `withTenant` already opened, never a bare
 * `Database` handle.
 */
export class DrizzleConsentRepository implements ConsentRepository {
  constructor(
    private readonly tx: Tx,
    private readonly userId: UserId,
  ) {}

  async findByPurpose(userId: UserId, purpose: ConsentPurpose): Promise<ConsentRecord | null> {
    const [row] = await this.tx
      .select()
      .from(consents)
      .where(and(eq(consents.userId, userId), eq(consents.purpose, purpose)));
    return row ? toDomain(row) : null;
  }

  async listForUser(userId: UserId): Promise<readonly ConsentRecord[]> {
    const rows = await this.tx.select().from(consents).where(eq(consents.userId, userId));
    return rows.map(toDomain);
  }

  /** `ON CONFLICT (user_id, purpose)` — grant/revoke both call this, and a retry never duplicates the row (AR-19-style idempotency). */
  async upsert(record: ConsentRecord): Promise<void> {
    await this.tx
      .insert(consents)
      .values({
        id: record.id,
        userId: this.userId,
        purpose: record.purpose,
        grantedAt: record.grantedAt,
        revokedAt: record.revokedAt,
        policyVersion: record.policyVersion,
      })
      .onConflictDoUpdate({
        target: [consents.userId, consents.purpose],
        set: {
          grantedAt: record.grantedAt,
          revokedAt: record.revokedAt,
          policyVersion: record.policyVersion,
          updatedAt: new Date(),
        },
      });
  }
}

function toDomain(row: typeof consents.$inferSelect): ConsentRecord {
  return {
    id: ConsentId.of(row.id),
    userId: row.userId as UserId,
    // `consents_purpose_check` restricts this to `CONSENT_PURPOSES`.
    purpose: row.purpose as ConsentPurpose,
    grantedAt: row.grantedAt,
    revokedAt: row.revokedAt,
    policyVersion: row.policyVersion,
  };
}
