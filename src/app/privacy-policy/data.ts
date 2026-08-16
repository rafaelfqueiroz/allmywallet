import { db } from '@/db/client';
import { resolveConfig } from '@/config/resolve';

/**
 * AR-31: the policy page is a Server Component and does not touch `db` itself
 * — the same split `(settings)/privacy/data.ts` and `preferences/data.ts` use.
 *
 * BR-004-14 makes the retention windows **configuration**, not constants, so
 * the published policy has to read the same registry the deletion sweep and
 * the audit purge read. A policy naming a different number than the scheduler
 * enforces is a false statement about how long data is kept, and it is the
 * kind that survives review precisely because both halves look right on their
 * own.
 */
export interface PublishedRetentionWindows {
  readonly deletionWindowDays: number;
  readonly auditMonths: number;
}

export async function loadPublishedRetentionWindows(): Promise<PublishedRetentionWindows> {
  const [deletionWindow, audit] = await Promise.all([
    resolveConfig('retention.deletion_window_days', { db }),
    resolveConfig('retention.audit_months', { db }),
  ]);
  return { deletionWindowDays: deletionWindow.value, auditMonths: audit.value };
}
