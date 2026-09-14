import { getPool } from '@/db/client';
import { tryUserId } from '@/lib/session';
import { readFailedBackup, type FailedBackup } from '@/lib/health';

export type { FailedBackup };

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

export async function loadFailedBackup(): Promise<FailedBackup | null> {
  if (!(await tryUserId())) return null;
  try {
    return await readFailedBackup(getPool());
  } catch {
    // A notice must never take a page down; /api/health reports the probe failure.
    return null;
  }
}
