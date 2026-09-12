import type { AssetId } from '@/core/shared/ids';
import type { DomainError } from '@/core/shared/domain-error';
import type { Quantity } from '@/core/shared/money';
import type { Result } from '@/core/shared/result';
import type { FixedIncomeContract, FixedIncomeIndexer } from '@/core/valuation/ports';

/**
 * SPEC-009 BR-009-13 / SPEC-020 BR-020-19 — the user supplies the indexer and
 * contracted rate an extract could not provide. CONTRACT STUB: signatures are
 * fixed; the body is implemented by the backend dispatch.
 */
export interface ContractTermsPort {
  findByAssetId(assetId: AssetId): Promise<FixedIncomeContract | null>;
  updateTerms(input: {
    readonly assetId: AssetId;
    readonly indexer: FixedIncomeIndexer;
    readonly ratePercent: Quantity;
  }): Promise<void>;
}

export interface SupplyContractTermsInput {
  readonly assetId: AssetId;
  /** Raw form value; validated against `FIXED_INCOME_INDEXERS`. */
  readonly indexer: string;
  /** Raw decimal string, already normalised from pt-BR input; never a JS number (AR-06). */
  readonly ratePercent: string;
}

export async function supplyContractTerms(
  _deps: { readonly contracts: ContractTermsPort },
  _input: SupplyContractTermsInput,
): Promise<Result<void, DomainError>> {
  throw new Error('not implemented');
}
