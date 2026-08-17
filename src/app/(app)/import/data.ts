import { db } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { resolveConfig } from '@/config/resolve';
import { businessDateInSaoPaulo, SystemClock, type BusinessDate } from '@/core/shared/clock';
import type { ImportBatchId, UserId } from '@/core/shared/ids';
import type { ImportBatch, ImportRow } from '@/core/ingestion/ports';
import { daysSinceImport, isImportStale } from '@/core/ingestion/staleness';
import {
  buildPostImportSummary,
  type PostImportSummary,
} from '@/core/ingestion/post-import-summary';
import { listPendingAllocations } from '@/core/wallets/pending';
import { withIngestionDeps } from '@/app/(app)/import/composition';
import { withWalletDeps } from '@/app/(app)/wallets/composition';

/**
 * AR-31: Server Components call a use case / repository read in `core/`
 * directly, never `db` from the component itself — this module is the seam
 * `page.tsx` reads through.
 */
export async function listImportBatches(userId: UserId): Promise<readonly ImportBatch[]> {
  return withIngestionDeps(userId, (deps) => deps.batches.listAll());
}

/**
 * SPEC-005 BR-005-28 — everything the import page needs to decide whether to
 * prompt, in one read.
 *
 * `thresholdDays` is resolved rather than assumed: `import.staleness_days` has
 * a **user** level, so a quarterly importer's own setting has to win over the
 * deployment default here exactly as it does in the reminder job. Two places
 * deciding "is this stale" from different numbers is how a user ends up
 * nagged on screen by a threshold they already raised.
 */
export interface ImportFreshness {
  readonly lastImportAt: BusinessDate | null;
  readonly daysSinceImport: number | null;
  readonly thresholdDays: number;
  readonly stale: boolean;
  /** No batch has ever been committed — the guide leads rather than follows. */
  readonly firstRun: boolean;
}

export async function loadImportFreshness(
  userId: UserId,
  batches: readonly ImportBatch[],
): Promise<ImportFreshness> {
  const today = new SystemClock().today();

  // AR-11, and not a formality here: `config_overrides` is tenant-scoped, and
  // its RLS policy casts `current_setting('app.user_id')` to uuid. Outside a
  // `withTenant` transaction that setting is the empty string, so the policy
  // does not quietly return nothing — it raises 22P02 and takes the whole page
  // down with it. Reading a user-level config key is a tenant query like any
  // other.
  const thresholdDays = await withTenant(
    userId,
    async (tx) => (await resolveConfig('import.staleness_days', { db: tx, userId })).value,
    db,
  );

  // The most recent *commit*, not the most recent upload: a batch staged and
  // abandoned changed nothing about how current the ledger is, and counting it
  // would silence the prompt for someone whose data never actually landed.
  let latest: Date | null = null;
  for (const batch of batches) {
    if (batch.committedAt === null) continue;
    if (latest === null || batch.committedAt > latest) latest = batch.committedAt;
  }

  const lastImportAt = latest === null ? null : businessDateInSaoPaulo(latest);

  return {
    lastImportAt,
    daysSinceImport: daysSinceImport(lastImportAt, today),
    thresholdDays,
    stale: isImportStale({ lastImportAt, today, thresholdDays }),
    firstRun: lastImportAt === null,
  };
}

export interface ImportBatchDetail {
  readonly batch: ImportBatch;
  readonly rows: readonly ImportRow[];
  readonly needsAttention: readonly ImportRow[];
  /**
   * SPEC-010 BR-010-15 — `null` until the batch is committed. Before that
   * nothing has been allocated and a summary would be describing a future.
   */
  readonly summary: PostImportSummary | null;
}

export async function loadImportBatchDetail(
  userId: UserId,
  batchId: ImportBatchId,
): Promise<ImportBatchDetail | null> {
  const detail = await withIngestionDeps(userId, async (deps) => {
    const batch = await deps.batches.findById(batchId);
    if (batch === null) return null;
    const rows = await deps.rows.listByBatch(batchId);
    return {
      batch,
      rows,
      needsAttention: rows.filter(
        (row) => row.classification === 'unclassified' || row.classification === 'invalid',
      ),
    };
  });

  if (detail === null || detail.batch.status !== 'committed') {
    return detail === null ? null : { ...detail, summary: null };
  }

  // A second tenant transaction rather than one: the wallet ports are a
  // different composition root, and the summary is a read of *current*
  // allocation state rather than of anything this batch froze — so it does not
  // need to share the ingestion read's snapshot, and pretending it did would
  // imply a consistency guarantee that is not the point (see
  // `post-import-summary.ts` on why current-state is the right answer).
  const { allocations, pending } = await withWalletDeps(userId, async (deps) => ({
    allocations: await deps.allocations.listAll(),
    pending: await listPendingAllocations(deps, userId),
  }));

  return {
    ...detail,
    summary: buildPostImportSummary({ rows: detail.rows, allocations, pending }),
  };
}
