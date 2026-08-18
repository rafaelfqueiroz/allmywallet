import { eq } from 'drizzle-orm';
import { chunked } from '@/adapters/db/chunk';
import { importRows } from '@/db/schema/import-rows';
import type { Tx } from '@/db/tenant';
import { BusinessDate } from '@/core/shared/clock';
import {
  AssetId,
  ImportBatchId,
  ImportRowId,
  InstitutionId,
  TransactionId,
} from '@/core/shared/ids';
import type { UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type { TransactionType } from '@/core/ledger/transaction';
import type {
  ImportRow,
  ImportRowClassification,
  ImportRowRepository,
  NormalizedRecord,
  RawRow,
} from '@/core/ingestion/ports';
import type { AssetClass } from '@/core/quotes/ports';
import type { FixedIncomeIndexer } from '@/core/valuation/ports';

/**
 * SPEC-005 — persistence for `import_rows`. AR-11: every method runs on a
 * `Tx` from `withTenant`.
 *
 * AR-10 is the whole reason this file exists as its own adapter rather than
 * a thin pass-through: `NormalizedRecord` carries `Money`/`Quantity`/
 * `BusinessDate` values, and `parsed_payload` is a jsonb column — a
 * `Decimal` that reaches `JSON.stringify` undetected comes back a float.
 * `serializeRecord`/`deserializeRecord` are the one place that boundary is
 * crossed explicitly.
 */
export class DrizzleImportRowRepository implements ImportRowRepository {
  constructor(
    private readonly tx: Tx,
    private readonly userId: UserId,
  ) {}

  /**
   * Chunked — see `chunk.ts`. One statement per 10.000 staged rows overflows
   * the call stack inside Drizzle's own query builder, which made the largest
   * import SPEC-005 names the one import that could not be staged.
   */
  async insertMany(rows: readonly ImportRow[]): Promise<void> {
    for (const chunk of chunked(rows)) {
      await this.tx.insert(importRows).values(chunk.map((row) => toRow(row, this.userId)));
    }
  }

  async findById(id: ImportRowId): Promise<ImportRow | null> {
    const [row] = await this.tx.select().from(importRows).where(eq(importRows.id, id));
    return row ? toDomain(row) : null;
  }

  async listByBatch(batchId: ImportBatchId): Promise<readonly ImportRow[]> {
    const rows = await this.tx.select().from(importRows).where(eq(importRows.batchId, batchId));
    return rows.map(toDomain);
  }

  async deleteByBatch(batchId: ImportBatchId): Promise<number> {
    const deleted = await this.tx
      .delete(importRows)
      .where(eq(importRows.batchId, batchId))
      .returning({ id: importRows.id });
    return deleted.length;
  }

  async attachTransactions(updates: ReadonlyMap<ImportRowId, TransactionId>): Promise<void> {
    for (const [rowId, transactionId] of updates) {
      await this.tx
        .update(importRows)
        .set({ transactionId, updatedAt: new Date() })
        .where(eq(importRows.id, rowId));
    }
  }

  async updateClassification(
    id: ImportRowId,
    classification: ImportRowClassification,
  ): Promise<void> {
    await this.tx
      .update(importRows)
      .set({ classification, updatedAt: new Date() })
      .where(eq(importRows.id, id));
  }
}

type Row = typeof importRows.$inferSelect;

function toRow(row: ImportRow, userId: UserId): typeof importRows.$inferInsert {
  return {
    id: row.id,
    userId,
    batchId: row.batchId,
    rawPayload: row.raw as unknown as Record<string, string>,
    parsedPayload: serializeRecord(row.record),
    classification: row.classification,
    assetId: row.assetId,
    institutionId: row.institutionId,
    naturalKey: row.naturalKey,
    occurrence: row.occurrence,
    ledgerType: row.ledgerType,
    transactionId: row.transactionId,
  };
}

function toDomain(row: Row): ImportRow {
  return {
    id: ImportRowId.of(row.id),
    batchId: ImportBatchId.of(row.batchId),
    raw: row.rawPayload as RawRow,
    record: deserializeRecord(row.parsedPayload),
    assetId: AssetId.of(row.assetId),
    institutionId: row.institutionId === null ? null : InstitutionId.of(row.institutionId),
    // `import_rows_classification_check` restricts this to the five known values.
    classification: row.classification as ImportRowClassification,
    naturalKey: row.naturalKey,
    occurrence: row.occurrence,
    ledgerType: row.ledgerType as TransactionType | null,
    transactionId: row.transactionId === null ? null : TransactionId.of(row.transactionId),
  };
}

function serializeRecord(record: NormalizedRecord): Record<string, unknown> {
  if (record.kind === 'transaction') {
    return {
      kind: 'transaction',
      b3Type: record.b3Type,
      direction: record.direction,
      assetCode: record.assetCode,
      assetName: record.assetName,
      assetClass: record.assetClass,
      institutionName: record.institutionName,
      tradeDate: record.tradeDate,
      quantity: record.quantity.toString(),
      unitPrice: record.unitPrice.toString(),
      fees: record.fees.toString(),
      ratio: record.ratio === null ? null : record.ratio.toString(),
    };
  }
  return {
    kind: 'position',
    assetCode: record.assetCode,
    assetName: record.assetName,
    assetClass: record.assetClass,
    institutionName: record.institutionName,
    quantity: record.quantity.toString(),
    asOf: record.asOf,
    fixedIncome:
      record.fixedIncome === null
        ? null
        : {
            indexer: record.fixedIncome.indexer,
            ratePercent:
              record.fixedIncome.ratePercent === null
                ? null
                : record.fixedIncome.ratePercent.toString(),
            issueDate: record.fixedIncome.issueDate,
            maturityDate: record.fixedIncome.maturityDate,
            principal:
              record.fixedIncome.principal === null
                ? null
                : record.fixedIncome.principal.toString(),
          },
  };
}

function deserializeRecord(raw: Record<string, unknown>): NormalizedRecord {
  if (raw['kind'] === 'transaction') {
    return {
      kind: 'transaction',
      b3Type: String(raw['b3Type']),
      direction: (raw['direction'] as 'credit' | 'debit' | null | undefined) ?? null,
      assetCode: String(raw['assetCode']),
      assetName: String(raw['assetName']),
      assetClass: raw['assetClass'] as AssetClass,
      institutionName: raw['institutionName'] === null ? null : String(raw['institutionName']),
      tradeDate: BusinessDate.of(String(raw['tradeDate'])),
      quantity: Quantity.fromString(String(raw['quantity'])),
      unitPrice: Money.fromString(String(raw['unitPrice'])),
      fees: Money.fromString(String(raw['fees'])),
      ratio: raw['ratio'] === null ? null : Quantity.fromString(String(raw['ratio'])),
    };
  }
  const fi = raw['fixedIncome'] as Record<string, unknown> | null;
  return {
    kind: 'position',
    assetCode: String(raw['assetCode']),
    assetName: String(raw['assetName']),
    assetClass: raw['assetClass'] as AssetClass,
    institutionName: raw['institutionName'] === null ? null : String(raw['institutionName']),
    quantity: Quantity.fromString(String(raw['quantity'])),
    asOf: BusinessDate.of(String(raw['asOf'])),
    fixedIncome:
      fi === null
        ? null
        : {
            indexer: fi['indexer'] as FixedIncomeIndexer | null,
            ratePercent:
              fi['ratePercent'] === null ? null : Quantity.fromString(String(fi['ratePercent'])),
            issueDate: fi['issueDate'] === null ? null : BusinessDate.of(String(fi['issueDate'])),
            maturityDate:
              fi['maturityDate'] === null ? null : BusinessDate.of(String(fi['maturityDate'])),
            principal: fi['principal'] === null ? null : Money.fromString(String(fi['principal'])),
          },
  };
}
