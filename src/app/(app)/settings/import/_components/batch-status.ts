import type { ImportBatchStatus } from '@/core/ingestion/ports';

/**
 * SPEC-022 BR-022-31 — an import's status as a **semantic** badge, one place
 * for Histórico and the batch page.
 *
 * "Importado" and "Enviado, processando" used to share one grey, so the history
 * could not be read at a glance (#211):
 *
 * - `pending` is work the system is doing — **in progress**;
 * - `previewed` waits on the user's confirmation — a **warning**, the "needs
 *   you" colour, never the loss or destructive one (DS-05);
 * - `committed` is done — **success**;
 * - `discarded` is the user's own cancellation, nothing went wrong — **neutral**;
 * - `failed` could not be read — **danger**.
 */
export type BatchStatusVariant = 'progress' | 'warning' | 'success' | 'neutral' | 'danger';

export const BATCH_STATUS_VARIANT: Readonly<Record<ImportBatchStatus, BatchStatusVariant>> = {
  pending: 'progress',
  previewed: 'warning',
  committed: 'success',
  discarded: 'neutral',
  failed: 'danger',
};

/**
 * SPEC-005 BR-005-03 — the extract type is detected from the file's structure
 * when the worker stages it; until then `source` holds the upload's
 * placeholder (`actions.ts`), and a file that failed before detection keeps it
 * for good. Staging writes the type and the row counts in one update, so a
 * batch with counts is a batch whose type is known — and one without them says
 * "not identified" rather than a confident "Movimentação".
 */
export function typeDetected(batch: { readonly rowCounts: unknown }): boolean {
  return batch.rowCounts !== null;
}
