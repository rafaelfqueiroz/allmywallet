import { Pool } from 'pg';

/**
 * Seeds a tenant root into the real `users` table (SPEC-001, #4).
 *
 * This replaces the throwaway `stub-users.ts` that SPEC-002 needed while it was
 * built on a branch where `users` did not exist. Keeping the stub after #4
 * landed would have been worse than useless: it created a bare `users(id)`
 * ahead of the migrations, so the real `CREATE TABLE users` collided with it
 * (42P07) and every config integration suite failed at setup.
 *
 * `google_subject_id` is the identity key, not email (SPEC-001 DL-001-02), so it
 * is what has to be unique per seeded tenant.
 */
export async function seedUser(
  migrationUrl: string,
  userId: string,
  // SPEC-004 (#7): a caller that needs an assertable profile value (the
  // export test's `data.profile.email`) can supply one; every other caller
  // gets the same deterministic defaults as before.
  email = `${userId}@example.test`,
  name: string | null = null,
): Promise<void> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  try {
    await pool.query(
      `INSERT INTO users (id, google_subject_id, email, name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [userId, `google-subject-${userId}`, email, name],
    );
  } finally {
    await pool.end();
  }
}
