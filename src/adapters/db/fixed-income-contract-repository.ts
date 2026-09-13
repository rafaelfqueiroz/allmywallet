import { eq, sql } from 'drizzle-orm';
import { fixedIncomeContracts } from '@/db/schema/import-rows';
import { withTenant, type Tx } from '@/db/tenant';
import type { Database } from '@/db/client';
import { AssetId, FixedIncomeContractId } from '@/core/shared/ids';
import type { ImportBatchId, UserId } from '@/core/shared/ids';
import { BusinessDate } from '@/core/shared/clock';
import { Money } from '@/core/shared/money';
import type { Quantity } from '@/core/shared/money';
import type {
  FixedIncomeContract,
  FixedIncomeContractPort,
  FixedIncomeIndexer,
} from '@/core/valuation/ports';
import type { ContractTermsPort } from '@/core/valuation/supply-contract-terms';
import type { FixedIncomeContractWriterPort } from '@/core/ingestion/ports';

/**
 * SPEC-005 BR-005-06 — `fixed_income_contracts`. Implements both
 * `FixedIncomeContractPort` (SPEC-009's read side, declared in
 * `core/valuation/ports.ts` and previously defaulted to `NoContractStore`
 * because this table did not exist) and `FixedIncomeContractWriterPort`
 * (this spec's write side, `core/ingestion/ports.ts`) — one adapter, one
 * table, two roles.
 *
 * The read side takes a tenant-scoped `Tx` (AR-11): SPEC-009's valuation
 * handler already runs inside `withTenant` per tenant
 * (`src/worker/handlers/valuation.ts`'s `rebuildTenant`), so wiring this in
 * place of `NoContractStore` costs nothing there. `userId` is required by
 * the constructor — like `DrizzleTransactionRepository` — because the write
 * side must state `user_id` explicitly for the policy's `WITH CHECK` to have
 * something to verify (AR-11's write exception); the read side simply
 * ignores it and relies on RLS.
 */
export class DrizzleFixedIncomeContractRepository
  implements FixedIncomeContractPort, FixedIncomeContractWriterPort, ContractTermsPort
{
  constructor(
    private readonly tx: Tx | Database,
    private readonly userId: UserId,
  ) {}

  async findByAssetId(assetId: AssetId): Promise<FixedIncomeContract | null> {
    const [row] = await this.tx
      .select()
      .from(fixedIncomeContracts)
      .where(eq(fixedIncomeContracts.assetId, assetId));
    return row ? toDomain(row) : null;
  }

  /**
   * AR-19: `ON CONFLICT (user_id, asset_id)` — a retried commit updates the
   * one row rather than duplicating it.
   *
   * SPEC-020 BR-020-19 — `indexer`/`rate` use `COALESCE(new, existing)`
   * rather than a plain overwrite. Without it, a user who supplies the rate
   * `supplyContractTermsFor` was built for and then re-imports the same
   * Posição — ordinary usage, not an edge case: BR-020-21 has them import
   * their whole history, and a bank statement's fixed-income tab does not
   * always carry a readable indexer — would have the re-import silently
   * write the extract's `null` back over the value the user just typed,
   * reopening the exact gate they had just closed. Every other column keeps
   * the previous plain-overwrite behaviour: `issueDate`/`maturityDate`/
   * `principal`/`source` are B3's own data, not something a user supplies by
   * hand, so the newer extract is still the more trustworthy source for them.
   */
  async upsertByAsset(input: {
    assetId: AssetId;
    indexer: FixedIncomeIndexer | null;
    ratePercent: Quantity | null;
    issueDate: BusinessDate;
    maturityDate: BusinessDate | null;
    principal: Money | null;
    source: ImportBatchId;
  }): Promise<void> {
    await this.tx
      .insert(fixedIncomeContracts)
      .values({
        // AR-25: UUIDv7, generated in application code (Postgres 17 has no
        // native `uuidv7()` yet).
        id: FixedIncomeContractId.generate(),
        userId: this.userId,
        assetId: input.assetId,
        indexer: input.indexer,
        rate: input.ratePercent,
        issueDate: input.issueDate,
        maturityDate: input.maturityDate,
        principal: input.principal,
        source: input.source,
      })
      .onConflictDoUpdate({
        target: [fixedIncomeContracts.userId, fixedIncomeContracts.assetId],
        set: {
          // The indexer and the rate are one fact — "110" means nothing without
          // "% do CDI" — so they are replaced as a pair or not at all. A
          // per-column COALESCE let an extract's readable indexer land beside
          // a rate the user supplied for a *different* indexer (IPCA + 6
          // becoming 6% of CDI), with both columns non-null and so no gate to
          // reveal it.
          indexer: sql`CASE WHEN excluded.indexer IS NOT NULL AND excluded.rate IS NOT NULL THEN excluded.indexer ELSE ${fixedIncomeContracts.indexer} END`,
          rate: sql`CASE WHEN excluded.indexer IS NOT NULL AND excluded.rate IS NOT NULL THEN excluded.rate ELSE ${fixedIncomeContracts.rate} END`,
          issueDate: input.issueDate,
          maturityDate: input.maturityDate,
          principal: input.principal,
          source: input.source,
          updatedAt: new Date(),
        },
      });
  }

  /**
   * SPEC-020 BR-020-19 / `ContractTermsPort` — the write behind the
   * fixed-income gate's resolution screen. Unlike `upsertByAsset`, this is a
   * plain overwrite: the user is supplying the terms directly, not an
   * extract that might carry a `null`, so there is nothing to preserve
   * against.
   */
  async updateTerms(input: {
    readonly assetId: AssetId;
    readonly indexer: FixedIncomeIndexer;
    readonly ratePercent: Quantity;
  }): Promise<void> {
    await this.tx
      .update(fixedIncomeContracts)
      .set({ indexer: input.indexer, rate: input.ratePercent, updatedAt: new Date() })
      .where(eq(fixedIncomeContracts.assetId, input.assetId));
  }
}

/**
 * SPEC-009's default `FixedIncomeContractPort` for `handleValuationSnapshot`
 * (`src/worker/handlers/valuation.ts`), replacing `NoContractStore`.
 *
 * Why a second class rather than reusing `DrizzleFixedIncomeContractRepository`
 * above: that one is handed an **already-open** tenant transaction by
 * `commit-batch.ts`'s composition root, because the write has to land inside
 * the same atomic commit. `computeSnapshots` runs with **no transaction
 * open** by design (`rebuildTenant`'s step 2 — the whole point is not to
 * hold a tenant connection across a potentially multi-year computation), so
 * this class instead opens its own short `withTenant` per lookup. That is
 * correct rather than merely convenient: `fixed_income_contracts` is
 * tenant-scoped and `FORCE`d, so a lookup with no tenant context set would
 * either raise (TS-16) or, if this class instead held a bare `Database`
 * outside any transaction, do exactly that on every call — a lookup a call
 * or two per fixed-income asset held, not a hot path, so the extra
 * transaction per call costs nothing that matters at this volume.
 */
export class DrizzleFixedIncomeContractReader implements FixedIncomeContractPort {
  constructor(
    private readonly database: Database,
    private readonly userId: UserId,
  ) {}

  async findByAssetId(assetId: AssetId): Promise<FixedIncomeContract | null> {
    return withTenant(
      this.userId,
      async (tx) => {
        const [row] = await tx
          .select()
          .from(fixedIncomeContracts)
          .where(eq(fixedIncomeContracts.assetId, assetId));
        return row ? toDomain(row) : null;
      },
      this.database,
    );
  }
}

function toDomain(row: typeof fixedIncomeContracts.$inferSelect): FixedIncomeContract {
  return {
    assetId: AssetId.of(row.assetId),
    // `fixed_income_contracts_indexer_check` restricts this to the three known values.
    indexer: row.indexer as FixedIncomeIndexer | null,
    ratePercent: row.rate,
    issueDate: BusinessDate.of(row.issueDate),
    maturityDate: row.maturityDate === null ? null : BusinessDate.of(row.maturityDate),
    // `FixedIncomeContract.principal` (SPEC-009's read type) is non-nullable
    // — reconciliation/"Needs attention" display, never the accrual base — so
    // an extract that omitted it reads as zero rather than widening the port.
    principal: row.principal ?? Money.zero(),
  };
}
