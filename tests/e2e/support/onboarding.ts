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
 * A staged, not yet committed batch — the guide's `review` stage (BR-020-04).
 * No rows: the guide reads only the batch's status, and a tenant in this state
 * has still not onboarded (BR-020-03).
 */
export async function seedPreviewedImportBatch(userId: string): Promise<string> {
  const batchId = randomUUID();
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    await pool.query(
      `INSERT INTO import_batches (id, user_id, source, status, uploaded_at)
       VALUES ($1, $2, 'b3_movimentacao', 'previewed', now())`,
      [batchId, userId],
    );
  } finally {
    await pool.end();
  }
  return batchId;
}

/**
 * A committed batch that left rows needing a decision — the `import_rows`
 * "Needs attention" gate (SPEC-020 BR-020-16). The asset is created for the
 * row's foreign key only; no position is written, so the dashboard shows the
 * queue beside a "no holdings" state rather than a figure.
 */
export async function seedUnclassifiedImportRows(
  userId: string,
  count: number,
): Promise<{ readonly batchId: string }> {
  const batchId = randomUUID();
  const assetId = randomUUID();
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    await pool.query(
      `INSERT INTO import_batches (id, user_id, source, status, uploaded_at, committed_at)
       VALUES ($1, $2, 'b3_movimentacao', 'committed', now(), now())`,
      [batchId, userId],
    );
    await pool.query(`INSERT INTO assets (id, code, name, class) VALUES ($1, $2, $3, 'cdb')`, [
      assetId,
      `UNCL${assetId.slice(0, 6).toUpperCase()}`,
      'Ativo de linha sem classificação',
    ]);
    for (let index = 0; index < count; index += 1) {
      await pool.query(
        `INSERT INTO import_rows (id, user_id, batch_id, raw_payload, parsed_payload, classification, asset_id)
         VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, 'unclassified', $4)`,
        [randomUUID(), userId, batchId, assetId],
      );
    }
  } finally {
    await pool.end();
  }
  return { batchId };
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
