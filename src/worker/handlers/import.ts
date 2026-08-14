import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@/lib/logger';
import { env } from '@/lib/env';
import { db as globalDb, type Database } from '@/db/client';
import { withTenant, type Tx } from '@/db/tenant';
import { SystemClock, type Clock } from '@/core/shared/clock';
import { ImportBatchId, UserId } from '@/core/shared/ids';
import type { IngestionPort } from '@/core/ingestion/ports';
import type { IngestionDependencies } from '@/core/ingestion/dependencies';
import { stageBatch } from '@/core/ingestion/stage-batch';
import { commitBatch } from '@/core/ingestion/commit-batch';
import { cancelBatch } from '@/core/ingestion/cancel-batch';
import { DrizzleImportBatchRepository } from '@/adapters/db/import-batch-repository';
import { DrizzleImportRowRepository } from '@/adapters/db/import-row-repository';
import { DrizzleTransactionRepository } from '@/adapters/db/transaction-repository';
import { DrizzlePositionRepository } from '@/adapters/db/position-repository';
import {
  DrizzleAssetResolver,
  DrizzleInstitutionResolver,
} from '@/adapters/db/ingestion-resolvers';
import { DrizzleFixedIncomeContractRepository } from '@/adapters/db/fixed-income-contract-repository';
import { XlsxIngestionPort } from '@/adapters/ingestion/xlsx';

/**
 * SPEC-005 — `import.stage` and `import.commit`. AR-04: thin entrypoints;
 * every rule lives in `core/ingestion/`.
 *
 * **File storage.** A server action under `src/app/(app)/import/` writes the
 * uploaded bytes to `IMPORT_UPLOAD_DIR` (env, not SPEC-002 — see
 * `src/lib/env.ts`) before creating the `pending` batch row and enqueuing
 * `import.stage`, named by `batchId` alone (no filename — see
 * `src/db/schema/transactions.ts`). BR-005-12/DL-005-07: the file is deleted
 * after a successful commit *and* after cancel, and never before either, so
 * the one place a raw CPF can exist stops existing the moment the batch no
 * longer needs it.
 *
 * **Idempotency (AR-19).** `commitBatch` itself is idempotent — a batch
 * already `committed` is a no-op success (see its own doc comment) — so a
 * retried `import.commit` is safe even if the first attempt's file deletion
 * already ran.
 */
export interface ImportHandlerDeps {
  readonly database: Database;
  readonly clock: Clock;
  readonly ingestion: IngestionPort;
  readonly uploadDir: string;
}

function resolveDeps(overrides?: Partial<ImportHandlerDeps>): ImportHandlerDeps {
  return {
    database: overrides?.database ?? globalDb,
    clock: overrides?.clock ?? new SystemClock(),
    ingestion: overrides?.ingestion ?? new XlsxIngestionPort(),
    uploadDir: overrides?.uploadDir ?? env().IMPORT_UPLOAD_DIR,
  };
}

/** The composition root (AR-02): every `core/ingestion` port wired to its Drizzle adapter, inside one tenant transaction. */
export function buildIngestionDeps(tx: Tx, userId: UserId, clock: Clock): IngestionDependencies {
  return {
    batches: new DrizzleImportBatchRepository(tx, userId),
    rows: new DrizzleImportRowRepository(tx, userId),
    transactions: new DrizzleTransactionRepository(tx, userId),
    positions: new DrizzlePositionRepository(tx, userId),
    assets: new DrizzleAssetResolver(tx),
    institutions: new DrizzleInstitutionResolver(tx),
    fixedIncomeContracts: new DrizzleFixedIncomeContractRepository(tx, userId),
    clock,
  };
}

export function importFilePath(uploadDir: string, batchId: ImportBatchId): string {
  return join(uploadDir, `${batchId}.xlsx`);
}

export async function saveUploadedFile(
  uploadDir: string,
  batchId: ImportBatchId,
  bytes: Uint8Array,
): Promise<void> {
  await mkdir(uploadDir, { recursive: true });
  await writeFile(importFilePath(uploadDir, batchId), bytes);
}

async function deleteUploadedFile(uploadDir: string, batchId: ImportBatchId): Promise<void> {
  await rm(importFilePath(uploadDir, batchId), { force: true });
}

export interface ImportJobPayload {
  readonly batchId: string;
  readonly userId: string;
}

/**
 * SPEC-005 `import.stage` — BR-005-09..11. Parses the file (AR-53: here, in
 * the worker) and stages rows; nothing reaches the ledger. The file is kept
 * — cancel and commit are both still ahead of it.
 */
export async function handleImportStage(
  payload: ImportJobPayload,
  overrides?: Partial<ImportHandlerDeps>,
): Promise<void> {
  const deps = resolveDeps(overrides);
  const userId = UserId.of(payload.userId);
  const batchId = ImportBatchId.of(payload.batchId);

  const fileBytes = await readFile(importFilePath(deps.uploadDir, batchId));
  const parsed = await deps.ingestion.parse(fileBytes);
  if (!parsed.ok) {
    // BR-005-05: the code and structural context are exactly what AR-38's
    // i18n layer needs to render a specific, actionable error — logged here
    // (AR-39: no personal data, only the code/context) because this handler
    // has no request to return one to. Surfacing it live in the preview UI
    // is `src/app/(app)/import/`'s job when it next reads the batch; today
    // that means the batch is left `pending` and visible as stalled rather
    // than carrying the error inline — a known gap, not a silent one.
    logger.error(
      { queue: 'import.stage', batchId, code: parsed.error.code, context: parsed.error.context },
      'SPEC-005 BR-005-05: extract could not be parsed',
    );
    throw new Error(`import.stage: ${parsed.error.code}`);
  }

  const result = await withTenant(
    userId,
    async (tx) =>
      stageBatch(buildIngestionDeps(tx, userId, deps.clock), userId, {
        batchId,
        extract: parsed.value,
      }),
    deps.database,
  );

  if (!result.ok) {
    logger.error(
      { queue: 'import.stage', batchId, code: result.error.code },
      'SPEC-005: staging failed',
    );
    throw new Error(`import.stage: ${result.error.code}`);
  }

  // BR-005-21: the type string alone, no values.
  for (const b3Type of result.value.unmappedTypes) {
    logger.warn(
      { queue: 'import.stage', batchId, b3Type },
      'SPEC-005 BR-005-18/21: unmapped movement type',
    );
  }

  logger.info(
    { queue: 'import.stage', batchId, counts: result.value.counts },
    'SPEC-005 BR-005-10: batch staged',
  );
}

/**
 * SPEC-005 `import.commit` — BR-005-13. AR-19: idempotent (delegated to
 * `commitBatch`'s own no-op-on-already-committed path). Deletes the source
 * file only after a successful commit (BR-005-12/DL-005-07).
 */
export async function handleImportCommit(
  payload: ImportJobPayload,
  overrides?: Partial<ImportHandlerDeps>,
): Promise<void> {
  const deps = resolveDeps(overrides);
  const userId = UserId.of(payload.userId);
  const batchId = ImportBatchId.of(payload.batchId);

  const result = await withTenant(
    userId,
    async (tx) => commitBatch(buildIngestionDeps(tx, userId, deps.clock), userId, { batchId }),
    deps.database,
  );

  if (!result.ok) {
    logger.error(
      { queue: 'import.commit', batchId, code: result.error.code },
      'SPEC-005: commit failed',
    );
    throw new Error(`import.commit: ${result.error.code}`);
  }

  await deleteUploadedFile(deps.uploadDir, batchId);

  logger.info(
    {
      queue: 'import.commit',
      batchId,
      applied: result.value.applied,
      skippedDuplicates: result.value.skippedDuplicates,
      invalid: result.value.invalid,
      reconciliationStatus: result.value.batch.reconciliation?.status ?? null,
    },
    'SPEC-005 BR-005-13: batch committed',
  );
}

/**
 * BR-005-12 — cancel is synchronous from the caller's perspective (a server
 * action calls this directly, not through a queue: BR-005-13's 60s budget is
 * about *commit*'s parse+apply cost, which cancel never pays). Kept here
 * rather than in the action itself so the file-deletion-after-DB-success
 * ordering lives in one place next to `handleImportCommit`'s identical rule.
 */
export async function handleImportCancel(
  payload: ImportJobPayload,
  overrides?: Partial<ImportHandlerDeps>,
): Promise<void> {
  const deps = resolveDeps(overrides);
  const userId = UserId.of(payload.userId);
  const batchId = ImportBatchId.of(payload.batchId);

  const result = await withTenant(
    userId,
    async (tx) => cancelBatch(buildIngestionDeps(tx, userId, deps.clock), userId, { batchId }),
    deps.database,
  );

  if (!result.ok) {
    logger.error(
      { queue: 'import.cancel', batchId, code: result.error.code },
      'SPEC-005: cancel failed',
    );
    throw new Error(`import.cancel: ${result.error.code}`);
  }

  await deleteUploadedFile(deps.uploadDir, batchId);
  logger.info({ queue: 'import.cancel', batchId }, 'SPEC-005 BR-005-12: batch cancelled');
}
