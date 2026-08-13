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
export async function seedUser(migrationUrl: string, userId: string): Promise<void> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  try {
    await pool.query(
      `INSERT INTO users (id, google_subject_id, email)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [userId, `google-subject-${userId}`, `${userId}@example.test`],
    );
  } finally {
    await pool.end();
  }
}
