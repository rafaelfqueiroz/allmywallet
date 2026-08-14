import type { ImportBatchId, UserId } from '@/core/shared/ids';
import type { ImportBatch, ImportRow } from '@/core/ingestion/ports';
import { withIngestionDeps } from '@/app/(app)/import/composition';

/**
 * AR-31: Server Components call a use case / repository read in `core/`
 * directly, never `db` from the component itself — this module is the seam
 * `page.tsx` reads through.
 */
export async function listImportBatches(userId: UserId): Promise<readonly ImportBatch[]> {
  return withIngestionDeps(userId, (deps) => deps.batches.listAll());
}

export interface ImportBatchDetail {
  readonly batch: ImportBatch;
  readonly rows: readonly ImportRow[];
  readonly needsAttention: readonly ImportRow[];
}

export async function loadImportBatchDetail(
  userId: UserId,
  batchId: ImportBatchId,
): Promise<ImportBatchDetail | null> {
  return withIngestionDeps(userId, async (deps) => {
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
}
