import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

/**
 * SPEC-020 — the two facts that move a tenant out of `shouldGuide` without
 * driving the guided flow itself: a committed import (BR-020-03, "onboarding
 * is complete at the first successfully committed import") and a dismissal
 * (BR-020-09/12, the one persisted onboarding fact). Every other E2E spec that
 * seeds a tenant and expects to land on `/dashboard` rather than `/onboarding`
 * needs one of the two — #97 added the redirect after most of those specs
 * were written, so this is what lets them keep testing what they always
 * tested instead of onboarding's own first-run branch.
 */

const MIGRATION_URL =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://allmywallet_migrator:allmywallet@localhost:5432/allmywallet';

/** A plain committed batch — no reconciliation payload, no rows. Just "this tenant has imported before." */
export async function seedCommittedImportBatch(userId: string): Promise<void> {
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    await pool.query(
      `INSERT INTO import_batches (id, user_id, source, status, uploaded_at, committed_at)
       VALUES ($1, $2, 'b3_negociacao', 'committed', now(), now())`,
      [randomUUID(), userId],
    );
  } finally {
    await pool.end();
  }
}

/**
 * Writes `users.onboarding_dismissed_at` directly, bypassing the UI — for
 * specs whose subject is not onboarding itself and that only need a tenant
 * past the BR-020-02 redirect (BR-020-14: a dismissed, import-less tenant
 * still sees the dashboard's own empty state).
 */
export async function dismissOnboarding(userId: string): Promise<void> {
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    await pool.query(`UPDATE users SET onboarding_dismissed_at = now() WHERE id = $1`, [userId]);
  } finally {
    await pool.end();
  }
}
