import { eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import { users } from '@/db/schema/users';
import { UserId } from '@/core/shared/ids';
import type { UpsertUserInput, User, UserRepository } from '@/core/identity/ports';

/**
 * `users` is not RLS-scoped (it is the tenant root — see the comment on the
 * table itself), so unlike every future tenant-scoped repository this one
 * legitimately queries `db` directly rather than through `withTenant`.
 */
export class DrizzleUserRepository implements UserRepository {
  constructor(private readonly db: Database) {}

  /**
   * SPEC-001 BR-001-04: `ON CONFLICT (google_subject_id) DO UPDATE` is what
   * makes this idempotent even under a genuine race — two concurrent OAuth
   * callbacks for the same Google account (a double-submitted form, a
   * network retry) both reach this statement, and Postgres serialises the
   * conflict so exactly one row exists afterwards, never two. A JS-level
   * "check then insert" cannot give that guarantee.
   */
  async upsertByGoogleSubject(input: UpsertUserInput): Promise<User> {
    const [row] = await this.db
      .insert(users)
      .values({
        googleSubjectId: input.googleSubjectId,
        email: input.email,
        name: input.name,
        imageUrl: input.imageUrl,
      })
      .onConflictDoUpdate({
        target: users.googleSubjectId,
        // SPEC-001 DL-001-02: email is refreshed from Google on every sign-in
        // (Google is the source of truth for it) but is never the match key.
        set: {
          email: input.email,
          name: input.name,
          imageUrl: input.imageUrl,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row)
      throw new Error('DrizzleUserRepository.upsertByGoogleSubject: upsert returned no row');
    return toDomain(row);
  }

  async findById(id: UserId): Promise<User | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id));
    return row ? toDomain(row) : null;
  }
}

function toDomain(row: typeof users.$inferSelect): User {
  return {
    id: UserId.of(row.id),
    googleSubjectId: row.googleSubjectId,
    email: row.email,
    name: row.name,
    imageUrl: row.imageUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
