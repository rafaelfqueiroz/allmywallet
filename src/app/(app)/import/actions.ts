'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireUserId } from '@/lib/session';
import { env } from '@/lib/env';
import { db } from '@/db/client';
import { resolveConfig } from '@/config/resolve';
import { AssetId, ImportBatchId, ImportRowId, InstitutionId } from '@/core/shared/ids';
import { Quantity } from '@/core/shared/money';
import { isErr } from '@/core/shared/result';
import { TRANSACTION_TYPES, type TransactionType } from '@/core/ledger/transaction';
import { classifyImportRow } from '@/core/ingestion/classify-row';
import { acceptReconciliationAdjustment } from '@/core/ingestion/accept-adjustment';
import { applyLedgerEffects } from '@/core/wallets/apply-ledger-effects';
import { withIngestionAndWalletDeps, withIngestionDeps } from '@/app/(app)/import/composition';
import { handleImportCancel, saveUploadedFile } from '@/worker/handlers/import';
import { enqueue } from '@/lib/queue';
import { QUEUE } from '@/worker/queues';

/**
 * AR-32: each action validates input with Zod at the boundary (DV-07),
 * resolves the session, and calls exactly one use case (or, for
 * upload/commit, enqueues exactly one job — AR-16, only the worker consumes
 * `import.stage`/`import.commit`).
 */

const UploadSchema = z.object({
  file: z
    .instanceof(File)
    .refine((f) => f.size > 0, 'empty file')
    .refine((f) => f.name.toLowerCase().endsWith('.xlsx') || f.name.toLowerCase().endsWith('.xls')),
});

/**
 * BR-005-02/03: the extract type is not known until the worker's
 * structure-based detection runs on the actual bytes (AR-53 keeps that out
 * of this process). `import_batches.source` is `NOT NULL`, so this is a
 * placeholder `stage-batch.ts` corrects to the detected type the moment
 * staging completes — see that file's comment.
 */
const PLACEHOLDER_SOURCE = 'b3_movimentacao';

export async function uploadExtractAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const parsed = UploadSchema.safeParse({ file: formData.get('file') });
  if (!parsed.success) return;

  // BR-005-02: reject oversized uploads before they ever reach disk.
  const maxUploadMb = (await resolveConfig('import.max_upload_mb', { db })).value;
  if (parsed.data.file.size > maxUploadMb * 1024 * 1024) return;

  const batchId = ImportBatchId.generate();
  const bytes = new Uint8Array(await parsed.data.file.arrayBuffer());

  await withIngestionDeps(userId, (deps) =>
    deps.batches.insert({
      id: batchId,
      userId,
      source: PLACEHOLDER_SOURCE,
      status: 'pending',
      uploadedAt: deps.clock.now(),
      committedAt: null,
      rowCounts: null,
      reconciliation: null,
      failureCode: null,
    }),
  );

  await saveUploadedFile(env().IMPORT_UPLOAD_DIR, batchId, bytes);
  await enqueue(QUEUE.IMPORT_STAGE, { batchId, userId });

  revalidatePath('/import');
  redirect(`/import/${batchId}`);
}

const BatchIdSchema = z.object({ batchId: z.string() });

export async function commitBatchAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const parsed = BatchIdSchema.safeParse({ batchId: formData.get('batchId') });
  if (!parsed.success) return;

  const batchId = ImportBatchId.of(parsed.data.batchId);
  await enqueue(QUEUE.IMPORT_COMMIT, { batchId, userId });
  revalidatePath(`/import/${batchId}`);
}

export async function cancelBatchAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const parsed = BatchIdSchema.safeParse({ batchId: formData.get('batchId') });
  if (!parsed.success) return;

  const batchId = ImportBatchId.of(parsed.data.batchId);
  // BR-005-12: synchronous, not a queue — cancel never pays commit's parse
  // cost, so there is no 60s budget to protect against here.
  await handleImportCancel({ batchId, userId });
  revalidatePath('/import');
  redirect('/import');
}

const ClassifySchema = z.object({
  rowId: z.string(),
  type: z.enum(TRANSACTION_TYPES),
  ratio: z.string().optional(),
});

export async function classifyRowAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const parsed = ClassifySchema.safeParse({
    rowId: formData.get('rowId'),
    type: formData.get('type'),
    ratio: formData.get('ratio') || undefined,
  });
  if (!parsed.success) return;

  const result = await withIngestionDeps(userId, (deps) =>
    classifyImportRow(deps, {
      rowId: ImportRowId.of(parsed.data.rowId),
      type: parsed.data.type as TransactionType,
      ratio: parsed.data.ratio ? Quantity.fromString(parsed.data.ratio) : null,
    }),
  );
  if (isErr(result)) return;

  revalidatePath('/import');
}

const AcceptAdjustmentSchema = z.object({
  batchId: z.string(),
  assetId: z.string(),
  institutionId: z.string().optional(),
});

export async function acceptAdjustmentAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const parsed = AcceptAdjustmentSchema.safeParse({
    batchId: formData.get('batchId'),
    assetId: formData.get('assetId'),
    institutionId: formData.get('institutionId') || undefined,
  });
  if (!parsed.success) return;

  const batchId = ImportBatchId.of(parsed.data.batchId);
  const result = await withIngestionAndWalletDeps(userId, async (deps, wallets) => {
    const accepted = await acceptReconciliationAdjustment(deps, userId, {
      batchId,
      assetId: AssetId.of(parsed.data.assetId),
      institutionId: parsed.data.institutionId ? InstitutionId.of(parsed.data.institutionId) : null,
    });
    if (!accepted.ok) return accepted;

    /**
     * SPEC-010 BR-010-05 — the adjustment is signed, so accepting B3's
     * *lower* figure removes shares. Allocations that did not follow left
     * allocated > held, on a user-triggered path with none of the import
     * commit's wiring behind it. Returning the error rolls the whole thing
     * back, for the reason `handleImportCommit` states.
     */
    const effects = await applyLedgerEffects(wallets, userId, [accepted.value.result.transaction]);
    if (!effects.ok) return effects;

    return accepted;
  });
  if (isErr(result)) return;

  revalidatePath(`/import/${batchId}`);
}
