import type { AssetId, UserId } from '@/core/shared/ids';
import type { DomainError } from '@/core/shared/domain-error';
import type { Result } from '@/core/shared/result';
import type { FixedIncomeIndexer } from '@/core/valuation/ports';
import {
  supplyContractTerms,
  type SupplyContractTermsInput,
} from '@/core/valuation/supply-contract-terms';
import { DrizzleAssetCatalogRepository } from '@/adapters/db/asset-catalog-repository';
import { DrizzleFixedIncomeContractRepository } from '@/adapters/db/fixed-income-contract-repository';
import { db } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { enqueue } from '@/lib/queue';
import { QUEUE } from '@/worker/queues';

/**
 * SPEC-020 BR-020-19 — the screen that resolves a missing fixed-income rate.
 */
export interface ContractTermsForm {
  readonly assetId: AssetId;
  readonly assetCode: string;
  readonly assetName: string;
  readonly indexer: FixedIncomeIndexer | null;
  /** AR-10 — a decimal string, never a number. */
  readonly ratePercent: string | null;
}

/** `null` when this tenant has no contract for the asset. */
export async function loadContractTermsForm(
  userId: UserId,
  assetId: AssetId,
): Promise<ContractTermsForm | null> {
  return withTenant(
    userId,
    async (tx) => {
      const contract = await new DrizzleFixedIncomeContractRepository(tx, userId).findByAssetId(
        assetId,
      );
      if (contract === null) return null;

      // `assets` is a shared, non-tenant table (AR-15) — reading it on this
      // same `Tx` costs nothing extra and keeps the form's asset label and
      // its contract inside one consistent read.
      const asset = await new DrizzleAssetCatalogRepository(tx).findById(assetId);
      // Unreachable in production: `fixed_income_contracts.asset_id` is a
      // foreign key into `assets`, so a contract row implies the asset
      // exists. Thrown rather than silently widened to `null` — AR-36
      // reserves `Result` for expected outcomes, and a broken foreign key is
      // not one.
      if (asset === null) {
        throw new Error(`loadContractTermsForm: asset not found for contract ${assetId}`);
      }

      return {
        assetId,
        assetCode: asset.code,
        assetName: asset.name,
        indexer: contract.indexer,
        ratePercent: contract.ratePercent === null ? null : contract.ratePercent.toString(),
      };
    },
    db,
  );
}

/**
 * SPEC-020 BR-020-19 / SPEC-009 BR-009-16 — after a successful write, the
 * held contract's carrying value has been wrong since its issue date, so the
 * rebuild runs `[issueDate, today]` rather than only today (the same
 * `valuation.snapshot` job the import commit path enqueues, with the same
 * "ids and dates only" payload shape — AR-21). Enqueued **after** the
 * transaction commits, for the same reason `handleImportCommit` does it
 * there: a failed enqueue must not undo a successful write, and the next
 * scheduled `valuation.snapshot`/`fixedincome.accrue` run would still pick it
 * up.
 */
export async function supplyContractTermsFor(
  userId: UserId,
  input: SupplyContractTermsInput,
): Promise<Result<void, DomainError>> {
  const outcome = await withTenant(
    userId,
    async (tx) => {
      const contracts = new DrizzleFixedIncomeContractRepository(tx, userId);
      const result = await supplyContractTerms({ contracts }, input);
      if (!result.ok) return { result, issueDate: null };
      const contract = await contracts.findByAssetId(input.assetId);
      return { result, issueDate: contract?.issueDate ?? null };
    },
    db,
  );

  if (outcome.result.ok && outcome.issueDate !== null) {
    await enqueue(QUEUE.VALUATION_SNAPSHOT, { userId, from: outcome.issueDate });
  }

  return outcome.result;
}
