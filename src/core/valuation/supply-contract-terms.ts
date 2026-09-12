import type { AssetId } from '@/core/shared/ids';
import { type DomainError, domainError } from '@/core/shared/domain-error';
import { Quantity } from '@/core/shared/money';
import { err, ok, type Result } from '@/core/shared/result';
import {
  FIXED_INCOME_INDEXERS,
  ValuationErrorCode,
  type FixedIncomeContract,
  type FixedIncomeIndexer,
} from '@/core/valuation/ports';

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

function isFixedIncomeIndexer(value: string): value is FixedIncomeIndexer {
  return (FIXED_INCOME_INDEXERS as readonly string[]).includes(value);
}

/**
 * SPEC-020 BR-020-19 — the write behind the fixed-income gate's resolution
 * screen. Three refusals, each a real state an extract or a hand-typed rate
 * can be in, and each returned rather than thrown (AR-36):
 *
 *  - no contract for the asset — `supplyContractTermsFor` is only reachable
 *    from a gate `describeGate` built for an existing contract, so this is
 *    unreachable in production and honestly reported rather than guessed at
 *    (the same reasoning `ValuationErrorCode.ASSET_NOT_FOUND` documents);
 *  - an indexer outside `FIXED_INCOME_INDEXERS` — a select the UI constrains,
 *    but the server action is the actual boundary (AR-32/DV-07 belongs to the
 *    Zod schema at that boundary; this is the domain's own check regardless
 *    of what reaches it);
 *  - a rate that does not parse as a positive decimal — `Quantity.fromString`
 *    throws on anything that is not a plain decimal literal (AR-06), and a
 *    rate of zero or below is not a contracted rate any instrument was sold
 *    at.
 */
export async function supplyContractTerms(
  deps: { readonly contracts: ContractTermsPort },
  input: SupplyContractTermsInput,
): Promise<Result<void, DomainError>> {
  // SPEC-020 BR-020-19: the contract must already exist — this screen
  // supplies missing terms, it never creates the contract itself.
  const contract = await deps.contracts.findByAssetId(input.assetId);
  if (contract === null) {
    return err(
      domainError(ValuationErrorCode.CONTRACT_TERMS_NOT_FOUND, { assetId: input.assetId }),
    );
  }

  if (!isFixedIncomeIndexer(input.indexer)) {
    return err(
      domainError(ValuationErrorCode.INDEXER_INVALID, {
        assetId: input.assetId,
        indexer: input.indexer,
      }),
    );
  }

  let ratePercent: Quantity;
  try {
    ratePercent = Quantity.fromString(input.ratePercent);
  } catch {
    return err(domainError(ValuationErrorCode.RATE_INVALID, { assetId: input.assetId }));
  }
  // SPEC-009 BR-009-13: a contracted rate of zero or negative is not one any
  // instrument was actually sold at — `Quantity.fromString` alone would
  // accept it, so the sign is checked here rather than left to accrual to
  // discover later.
  if (!ratePercent.isPositive()) {
    return err(domainError(ValuationErrorCode.RATE_INVALID, { assetId: input.assetId }));
  }

  await deps.contracts.updateTerms({ assetId: input.assetId, indexer: input.indexer, ratePercent });
  return ok(undefined);
}
