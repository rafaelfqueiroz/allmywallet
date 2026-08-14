import { type DomainError, domainError } from '@/core/shared/domain-error';

/**
 * SPEC-005 — use-case-level errors. `core/ingestion/ports.ts`'s
 * `IngestionErrorCode` covers what an xlsx parser itself can fail on
 * (BR-005-05); these cover the staging/commit/cancel/reconcile lifecycle
 * around it.
 */
export const IngestionUseCaseErrorCode = {
  BATCH_NOT_FOUND: 'IMPORT_BATCH_NOT_FOUND',
  /** BR-005-09: staging only ever runs on a freshly uploaded batch. */
  BATCH_NOT_PENDING: 'IMPORT_BATCH_NOT_PENDING',
  /** BR-005-13: commit only ever runs on a staged (previewed) batch. */
  BATCH_NOT_PREVIEWED: 'IMPORT_BATCH_NOT_PREVIEWED',
  /** BR-005-12: cancel only ever runs before a batch is committed. */
  BATCH_NOT_CANCELLABLE: 'IMPORT_BATCH_NOT_CANCELLABLE',
  /** A structurally valid extract with zero business rows — nothing to stage. */
  EMPTY_EXTRACT: 'IMPORT_EMPTY_EXTRACT',
  ROW_NOT_FOUND: 'IMPORT_ROW_NOT_FOUND',
  /** BR-005-20: only an `unclassified` row can be manually classified. */
  ROW_NOT_UNCLASSIFIED: 'IMPORT_ROW_NOT_UNCLASSIFIED',
} as const;
export type IngestionUseCaseErrorCode =
  (typeof IngestionUseCaseErrorCode)[keyof typeof IngestionUseCaseErrorCode];

export function ingestionError(
  code: IngestionUseCaseErrorCode,
  context: Readonly<Record<string, string | number | boolean | null>> = {},
): DomainError<IngestionUseCaseErrorCode> {
  return domainError(code, context);
}
