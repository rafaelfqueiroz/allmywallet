import { getPool } from '@/db/client';
import { tryUserId } from '@/lib/session';

/**
 * SPEC-021 BR-021-20 — "shown in the app until a backup succeeds". AR-31/AR-35
 * keep `@/db/*` out of layouts and components, so the read lives here, beside
 * `theme-data.ts`, and the frame imports only the function.
 *
 * `backup_runs` is shared operational state with no tenant column (see its
 * `SHARED_TABLES` entry), so there is no `withTenant` here. Only a signed-in
 * visitor is told: an anonymous page saying "the backup failed" discloses
 * something about the instance to someone who has no account on it.
 */
export interface FailedBackup {
  readonly failedAt: Date;
  readonly reason: string | null;
  readonly lastSuccessAt: Date | null;
}

export async function loadFailedBackup(): Promise<FailedBackup | null> {
  if (!(await tryUserId())) return null;

  try {
    const { rows } = await getPool().query<{
      status: string;
      detail: string | null;
      finished_at: Date;
      last_success: Date | null;
    }>(
      `SELECT latest.status, latest.detail, latest.finished_at,
              (SELECT max(finished_at) FROM backup_runs WHERE status = 'succeeded') AS last_success
         FROM (SELECT status, detail, finished_at FROM backup_runs ORDER BY finished_at DESC LIMIT 1) AS latest`,
    );
    const row = rows[0];
    if (!row || row.status !== 'failed') return null;
    return { failedAt: row.finished_at, reason: row.detail, lastSuccessAt: row.last_success };
  } catch {
    // A notice must never take a page down; /api/health reports the probe failure.
    return null;
  }
}
