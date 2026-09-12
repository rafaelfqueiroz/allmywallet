import type { AssetId, UserId } from '@/core/shared/ids';
import type { DomainError } from '@/core/shared/domain-error';
import type { Result } from '@/core/shared/result';
import type { FixedIncomeIndexer } from '@/core/valuation/ports';
import type { SupplyContractTermsInput } from '@/core/valuation/supply-contract-terms';

/**
 * SPEC-020 BR-020-19 — the screen that resolves a missing fixed-income rate.
 * CONTRACT STUB: signatures are fixed; bodies are implemented by the backend
 * dispatch.
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
  _userId: UserId,
  _assetId: AssetId,
): Promise<ContractTermsForm | null> {
  throw new Error('not implemented');
}

export async function supplyContractTermsFor(
  _userId: UserId,
  _input: SupplyContractTermsInput,
): Promise<Result<void, DomainError>> {
  throw new Error('not implemented');
}
