'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireUserId } from '@/lib/session';
import type { ActionState } from '@/lib/action-state';
import { IngestionErrorCode } from '@/core/ingestion/ports';
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

const ExtractFileSchema = z
  .instanceof(File)
  .refine((f) => f.size > 0, 'empty file')
  .refine((f) => f.name.toLowerCase().endsWith('.xlsx') || f.name.toLowerCase().endsWith('.xls'));

/**
 * SPEC-005 AC: "Files upload together or individually, **in any order**."
 *
 * `.min(1)` rather than a single `File`: the picker is `multiple`, so the
 * three extracts can be selected in one go. Order needs no handling at all —
 * each file becomes its own batch and the worker detects what it is from the
 * bytes (BR-005-03), so "in any order" is a property of structure-based
 * detection rather than something this action arranges.
 */
const UploadSchema = z.object({
  files: z.array(ExtractFileSchema).min(1),
});

/**
 * BR-005-02/03: the extract type is not known until the worker's
 * structure-based detection runs on the actual bytes (AR-53 keeps that out
 * of this process). `import_batches.source` is `NOT NULL`, so this is a
 * placeholder `stage-batch.ts` corrects to the detected type the moment
 * staging completes — see that file's comment.
 */
const PLACEHOLDER_SOURCE = 'b3_movimentacao';

/**
 * **All or nothing.** Every file is validated before any of them is written.
 *
 * That is not tidiness — it is the hazard multi-file upload introduces. A user
 * who picks three extracts and gets two, because the third was oversized and
 * the action returned quietly, has a *partial* import and nothing telling them
 * so. Reconciliation against the Posição snapshot would then report
 * discrepancies caused by the upload rather than by their broker, which is
 * exactly the kind of wrong answer SPEC-005 exists to avoid.
 *
 * The refusal is also *said* now (`ActionState`), rather than being a silent
 * `return` — the shape SPEC-006's write actions established and the same
 * reasoning: a rejection nobody can see is indistinguishable from a bug.
 */
export async function uploadExtractAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const userId = await requireUserId();
  const parsed = UploadSchema.safeParse({ files: formData.getAll('file') });
  if (!parsed.success) return uploadFailure(IngestionErrorCode.UNREADABLE_FILE);

  // BR-005-02: reject oversized uploads before they ever reach disk — checked
  // across the whole selection first, so nothing lands if one is too big.
  const maxUploadMb = (await resolveConfig('import.max_upload_mb', { db })).value;
  const limitBytes = maxUploadMb * 1024 * 1024;
  if (parsed.data.files.some((file) => file.size > limitBytes)) {
    return uploadFailure(IngestionErrorCode.FILE_TOO_LARGE, { maxUploadMb });
  }

  // Read every file before writing anything: `arrayBuffer()` is the last step
  // that can fail, and failing it after two batches exist is the partial state
  // this action refuses to produce.
  const uploads: { readonly batchId: ImportBatchId; readonly bytes: Uint8Array }[] = [];
  for (const file of parsed.data.files) {
    uploads.push({
      batchId: ImportBatchId.generate(),
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
  }

  await withIngestionDeps(userId, async (deps) => {
    for (const upload of uploads) {
      await deps.batches.insert({
        id: upload.batchId,
        userId,
        source: PLACEHOLDER_SOURCE,
        status: 'pending',
        uploadedAt: deps.clock.now(),
        committedAt: null,
        rowCounts: null,
        reconciliation: null,
        failureCode: null,
      });
    }
  });

  for (const upload of uploads) {
    await saveUploadedFile(env().IMPORT_UPLOAD_DIR, upload.batchId, upload.bytes);
    await enqueue(QUEUE.IMPORT_STAGE, { batchId: upload.batchId, userId });
  }

  revalidatePath('/import');
  // One file lands on its own batch, as before. Several have no single detail
  // page to show, so the history list — where all of them are visibly staging
  // — is the honest destination.
  const first = uploads[0];
  redirect(uploads.length === 1 && first !== undefined ? `/import/${first.batchId}` : '/import');
}

function uploadFailure(
  code: string,
  context: Readonly<Record<string, string | number | boolean | null>> = {},
): ActionState {
  return { status: 'error', code, context };
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
