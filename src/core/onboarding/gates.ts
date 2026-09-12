import type { AssetId, ImportBatchId } from '@/core/shared/ids';
import type { AttentionItem } from '@/core/dashboard/summary';

/**
 * SPEC-020 BR-020-15..19 — every "Needs attention" item states what is wrong
 * (its `kind`), what it prevents, and the one screen that resolves it.
 * CONTRACT STUB: signatures are fixed; the body is implemented by the backend
 * dispatch. The UI maps `GateResolution` to a route; core never names routes.
 */
export type GateConsequence =
  /** Unclassified rows are excluded from replay — every figure is understated. */
  | 'figures_understated'
  /** BR-020-19 — the contract cannot be valued; portfolio value is understated until supplied. */
  | 'portfolio_value_understated'
  /** Already inside the total; only the wallet filing is missing. */
  | 'allocation_missing';

export type GateResolution =
  | { readonly screen: 'import_batch'; readonly batchId: ImportBatchId }
  | { readonly screen: 'fixed_income_contract'; readonly assetId: AssetId }
  | { readonly screen: 'wallets' };

export interface GateDescription {
  readonly consequence: GateConsequence;
  readonly resolution: GateResolution;
}

export function describeGate(_item: AttentionItem): GateDescription {
  throw new Error('not implemented');
}
