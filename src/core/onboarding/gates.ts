import type { AssetId, ImportBatchId } from '@/core/shared/ids';
import type { AttentionItem } from '@/core/dashboard/summary';

/**
 * SPEC-020 BR-020-15..19 — every "Needs attention" item states what is wrong
 * (its `kind`), what it prevents, and the one screen that resolves it.
 * The UI maps `GateResolution` to a route; core never names routes.
 */
export type GateConsequence =
  /**
   * Unclassified or invalid rows are excluded from replay, so every figure may
   * be wrong — in either direction: an excluded purchase understates, an
   * excluded transfer out or redemption overstates.
   */
  | 'figures_unreliable'
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

/**
 * BR-020-18 — exhaustive over `AttentionItem['kind']` (the `never` check
 * below fails the build the day a fourth kind is added without a
 * description), so no queue item can reach the screen with nothing to say
 * about what it blocks or how to resolve it.
 */
export function describeGate(item: AttentionItem): GateDescription {
  switch (item.kind) {
    // SPEC-020 BR-020-16/18: a row a committed import left unclassified or
    // invalid is excluded from the replay behind every position (SPEC-006
    // BR-006-03). The direction is unknowable here — the row is exactly the
    // one nobody could read — so the consequence claims unreliability, never
    // "understated": an excluded outflow leaves units the user no longer holds.
    case 'import_rows':
      return {
        consequence: 'figures_unreliable',
        resolution: { screen: 'import_batch', batchId: item.batchId },
      };
    // SPEC-020 BR-020-16/19: a held fixed-income contract with no readable
    // rate cannot be accrued (SPEC-009 BR-009-13), so it is valued at cost —
    // portfolio value is understated until the user supplies the terms.
    case 'fixed_income_rate':
      return {
        consequence: 'portfolio_value_understated',
        resolution: { screen: 'fixed_income_contract', assetId: item.assetId },
      };
    // SPEC-020 BR-020-16: the purchase is already inside the total
    // (SPEC-010) — only the wallet filing is outstanding.
    case 'pending_allocation':
      return {
        consequence: 'allocation_missing',
        resolution: { screen: 'wallets' },
      };
    default: {
      const exhaustive: never = item;
      throw new Error(`describeGate: unhandled AttentionItem: ${JSON.stringify(exhaustive)}`);
    }
  }
}
