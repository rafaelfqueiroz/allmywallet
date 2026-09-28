import type { InstitutionId } from '@/core/shared/ids';
import { conversionEvidenceMovementOf } from '@/core/ingestion/movement-map';
import { issuerCodeOf } from '@/core/ingestion/issuer-code';
import type { ImportRow, SubscriptionEvidenceReader } from '@/core/ingestion/ports';
import {
  deriveSubscriptionHandClassification,
  resolveSubscriptions,
  type SubscriptionEvidence,
  type SubscriptionEvidenceState,
} from '@/core/ingestion/subscription-resolution';
import type { CloseDateRequest } from '@/core/quotes/fetch-closes-for-dates';

/**
 * SPEC-005 BR-005-20d (#144 review F1) — every credit a subscription pairing
 * *could* resolve to, from this batch's own staged rows plus whatever the
 * stored ledger already carries — not only pairs staged fresh in *this*
 * batch.
 *
 * A read-only preview, run before the commit transaction so the worker
 * (`backfillSubscriptionClosesForBatch`) knows which closes to fetch. It runs
 * the same pure resolver (`resolveSubscriptions`) `commitBatch`'s own
 * `planSubscriptions` does, over the same two evidence sources — this
 * batch's own still-`unclassified` rows, and `SubscriptionEvidenceReader`'s
 * whole stored ledger for the issuer — so three shapes the naive "scan this
 * batch's unclassified rows alone" version missed are all found here exactly
 * as `planSubscriptions` would find them at commit:
 *
 * - a pair **split across two imports** (the exercise staged and committed
 *   in an earlier batch, the credit only now);
 * - a **re-import** of a pair still unresolved (both rows now stage
 *   `duplicate`, since their stored copies already exist `unclassified` —
 *   there is no `unclassified` row left in *this* batch to scan at all);
 * - the credit half of a pair whose exercise is the one restaged.
 *
 * Deliberately simpler than `planSubscriptions` in one respect: D8's
 * balance-before refusal is not checked here (`balanceBefore` is always
 * absent, read by the pure resolver as "unknown", never refusing on it) —
 * this function only decides *which closes to fetch*, and treating every
 * shape match as a candidate can only ever cost an unneeded, harmless
 * request against a bounded, budget-checked provider call; the commit's own
 * `planSubscriptions` still enforces D8 before writing anything.
 */
export async function planSubscriptionCloseRequests(
  deps: { readonly subscriptionEvidence: SubscriptionEvidenceReader },
  rows: readonly ImportRow[],
  windowDays: number,
): Promise<readonly CloseDateRequest[]> {
  const isExerciseRow = (row: ImportRow): boolean =>
    row.record.kind === 'transaction' &&
    row.classification === 'unclassified' &&
    row.ledgerType === 'subscription';
  const isCreditRow = (row: ImportRow): boolean =>
    row.classification === 'unclassified' && isAtualizacaoShaped(row);
  // Classification-agnostic shape checks for the group-trigger scan: a
  // re-import stages an already-stored, still-unresolved pair `duplicate`,
  // not `unclassified` — the scan must still find its issuer to look up the
  // stored evidence at all.
  const looksLikeExercise = (row: ImportRow): boolean =>
    row.record.kind === 'transaction' && row.ledgerType === 'subscription';
  const looksLikeCredit = (row: ImportRow): boolean => isAtualizacaoShaped(row);

  const groups = new Map<string, { issuerRoot: string; institutionId: InstitutionId | null }>();
  for (const row of rows) {
    if (row.record.kind !== 'transaction' || (!looksLikeExercise(row) && !looksLikeCredit(row))) {
      continue;
    }
    const issuerRoot = issuerCodeOf(row.record.assetCode);
    if (issuerRoot === null) continue;
    groups.set(`${issuerRoot}|${row.institutionId ?? ''}`, {
      issuerRoot,
      institutionId: row.institutionId,
    });
  }

  const requests: CloseDateRequest[] = [];
  for (const { issuerRoot, institutionId } of groups.values()) {
    const storedEvidence = await deps.subscriptionEvidence.evidenceForIssuer(
      issuerRoot,
      institutionId,
    );

    const evidence: SubscriptionEvidence[] = [];
    const creditAssetById = new Map<string, { assetId: ImportRow['assetId']; assetCode: string }>();

    for (const row of rows) {
      if (
        row.record.kind !== 'transaction' ||
        row.institutionId !== institutionId ||
        issuerCodeOf(row.record.assetCode) !== issuerRoot
      ) {
        continue;
      }
      const isExercise = isExerciseRow(row);
      const isCredit = !isExercise && isCreditRow(row);
      if (!isExercise && !isCredit) continue;
      const id = `row:${row.id}`;
      evidence.push({
        id,
        role: isExercise ? 'exercise' : 'credit',
        assetCode: row.record.assetCode,
        tradeDate: row.record.tradeDate,
        quantity: row.record.quantity,
        state: 'open',
      });
      if (isCredit)
        creditAssetById.set(id, { assetId: row.assetId, assetCode: row.record.assetCode });
    }

    for (const item of storedEvidence) {
      const suffix = storedB3TypeOf(item.transaction.naturalKey);
      // #144 review F7 — the credit becomes `type: 'subscription'` too once
      // applied; only the natural key's own B3-type suffix tells the two
      // apart, never the transaction type alone.
      const isExercise =
        item.transaction.type === 'subscription' && suffix === 'direitos de subscricao - exercido';
      const isCredit = !isExercise && suffix === 'atualizacao';
      if (!isExercise && !isCredit) continue;
      const state: SubscriptionEvidenceState =
        imported(item.transaction) && item.transaction.status === 'unclassified'
          ? 'open'
          : 'locked';
      evidence.push({
        id: item.transaction.id,
        role: isExercise ? 'exercise' : 'credit',
        assetCode: item.assetCode,
        tradeDate: item.transaction.tradeDate,
        quantity: item.transaction.quantity,
        state,
        // SPEC-005 BR-005-20d (#157) — a locked credit's own classification,
        // so an `offer` pair (a locked, zero-cost hand classification) also
        // requests a close ahead of the user accepting it (DL-005-22: closes
        // are fetched before the commit/edit transaction, never inside it).
        ...(isCredit
          ? { handClassification: deriveSubscriptionHandClassification(item.transaction) }
          : {}),
      });
      if (isCredit) {
        creditAssetById.set(item.transaction.id, {
          assetId: item.transaction.assetId,
          assetCode: item.assetCode,
        });
      }
    }

    const resolution = resolveSubscriptions({ evidence, windowDays });
    for (const pair of resolution.pairs) {
      if (pair.status !== 'resolved' && pair.status !== 'offer') continue;
      const asset = creditAssetById.get(pair.plan.creditId);
      if (asset === undefined) continue;
      requests.push({
        assetId: asset.assetId,
        assetCode: asset.assetCode,
        upTo: pair.plan.tradeDate,
      });
    }
  }

  return requests;
}

function isAtualizacaoShaped(row: ImportRow): boolean {
  return (
    row.record.kind === 'transaction' &&
    conversionEvidenceMovementOf(row.record.b3Type, {
      assetClass: row.record.assetClass,
      priceStated: row.record.priceStated,
    }) === 'atualizacao'
  );
}

function storedB3TypeOf(naturalKey: string): string | null {
  const parts = naturalKey.split('|');
  return parts.length === 7 ? (parts[6] ?? null) : null;
}

function imported(transaction: {
  readonly isUserModified: boolean;
  readonly isManual: boolean;
  readonly importBatchId: unknown;
}): boolean {
  return !transaction.isUserModified && !transaction.isManual && transaction.importBatchId !== null;
}
