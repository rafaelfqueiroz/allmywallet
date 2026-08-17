import { desc, eq } from 'drizzle-orm';
import { importBatches } from '@/db/schema/transactions';
import type { Tx } from '@/db/tenant';
import { AssetId, ImportBatchId, InstitutionId, UserId } from '@/core/shared/ids';
import { BusinessDate } from '@/core/shared/clock';
import type {
  ExtractType,
  ImportBatch,
  ImportBatchRepository,
  ImportBatchStatus,
  ImportRowCounts,
  IngestionErrorCode,
} from '@/core/ingestion/ports';
import type { Discrepancy, ReconciliationReport } from '@/core/ingestion/reconcile';

/**
 * SPEC-005 — persistence for the ALTERed `import_batches` (SPEC-006/#6
 * created the table; this spec owns its shape from `status` onward).
 *
 * AR-11: every method runs on a `Tx` obtained from `withTenant` — the tenant
 * filter is not written into the WHERE clauses, RLS applies it (see
 * `adapters/db/transaction-repository.ts`'s header comment for the full
 * reasoning, identical here).
 */
export class DrizzleImportBatchRepository implements ImportBatchRepository {
  constructor(
    private readonly tx: Tx,
    private readonly userId: UserId,
  ) {}

  async insert(batch: ImportBatch): Promise<void> {
    await this.tx.insert(importBatches).values(toRow(batch, this.userId));
  }

  async findById(id: ImportBatchId): Promise<ImportBatch | null> {
    const [row] = await this.tx.select().from(importBatches).where(eq(importBatches.id, id));
    return row ? toDomain(row) : null;
  }

  async update(batch: ImportBatch): Promise<void> {
    const row = toRow(batch, this.userId);
    await this.tx
      .update(importBatches)
      .set({
        // BR-005-03: `source` is included — `stage-batch.ts` corrects a
        // placeholder value (set at upload, before any parsing) to the
        // structurally-detected extract type.
        source: row.source,
        status: row.status,
        committedAt: row.committedAt,
        rowCounts: row.rowCounts,
        reconciliation: row.reconciliation,
        // #63 / BR-005-05: the only writer of this column is `failBatch`, but
        // `update` is the single write path `ImportBatchRepository` exposes —
        // omitting it here would silently drop the failure code on the very
        // call that is supposed to persist it.
        failureCode: row.failureCode,
        updatedAt: new Date(),
      })
      .where(eq(importBatches.id, batch.id));
  }

  async listCommitted(): Promise<readonly ImportBatch[]> {
    const rows = await this.tx
      .select()
      .from(importBatches)
      .where(eq(importBatches.status, 'committed'));
    return rows.map(toDomain);
  }

  async listAll(): Promise<readonly ImportBatch[]> {
    const rows = await this.tx.select().from(importBatches).orderBy(desc(importBatches.uploadedAt));
    return rows.map(toDomain);
  }
}

type Row = typeof importBatches.$inferSelect;

function toRow(batch: ImportBatch, userId: UserId): typeof importBatches.$inferInsert {
  return {
    id: batch.id,
    userId,
    source: batch.source,
    status: batch.status,
    uploadedAt: batch.uploadedAt,
    committedAt: batch.committedAt,
    rowCounts: batch.rowCounts as unknown as Record<string, unknown> | null,
    reconciliation: batch.reconciliation as unknown as Record<string, unknown> | null,
    failureCode: batch.failureCode,
  };
}

function toDomain(row: Row): ImportBatch {
  return {
    id: ImportBatchId.of(row.id),
    userId: UserId.of(row.userId),
    // `import_batches_source_check` restricts this to the four known values.
    source: row.source as ExtractType,
    status: row.status as ImportBatchStatus,
    uploadedAt: row.uploadedAt,
    committedAt: row.committedAt,
    rowCounts: row.rowCounts === null ? null : (deserializeRowCounts(row.rowCounts) ?? null),
    reconciliation:
      row.reconciliation === null ? null : (deserializeReconciliation(row.reconciliation) ?? null),
    // No CHECK constrains this column's values (AR-30 applies to enum-like
    // *state* columns; a nullable free-form code does not need one) — safe to
    // widen the cast because the only writer, `failBatch`, only ever assigns a
    // real `IngestionErrorCode`.
    failureCode: row.failureCode as IngestionErrorCode | null,
  };
}

function deserializeRowCounts(raw: Record<string, unknown>): ImportRowCounts {
  return {
    read: Number(raw['read']),
    new: Number(raw['new']),
    duplicates: Number(raw['duplicates']),
    needsAttention: Number(raw['needsAttention']),
    fromDate:
      raw['fromDate'] === null || raw['fromDate'] === undefined
        ? null
        : BusinessDate.of(String(raw['fromDate'])),
    toDate:
      raw['toDate'] === null || raw['toDate'] === undefined
        ? null
        : BusinessDate.of(String(raw['toDate'])),
  };
}

function deserializeReconciliation(raw: Record<string, unknown>): ReconciliationReport {
  const discrepancies =
    (raw['discrepancies'] as readonly Record<string, unknown>[] | undefined) ?? [];
  return {
    asOf: BusinessDate.of(String(raw['asOf'])),
    status: raw['status'] as ReconciliationReport['status'],
    discrepancies: discrepancies.map((d): Discrepancy => ({
      assetId: AssetId.of(String(d['assetId'])),
      assetCode: String(d['assetCode']),
      institutionId:
        d['institutionId'] === null ? null : InstitutionId.of(String(d['institutionId'])),
      computedQuantity: String(d['computedQuantity']),
      b3Quantity: String(d['b3Quantity']),
      difference: String(d['difference']),
      cause: d['cause'] as Discrepancy['cause'],
      resolved: Boolean(d['resolved']),
    })),
  };
}
