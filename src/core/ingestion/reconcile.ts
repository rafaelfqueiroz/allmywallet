import type { BusinessDate } from '@/core/shared/clock';
import type { AssetId, InstitutionId } from '@/core/shared/ids';
import type { Quantity } from '@/core/shared/money';

/**
 * SPEC-005 BR-005-22..26 — computed ledger positions vs. B3's own Posição
 * snapshot, with cause attribution where determinable.
 *
 * Pure and framework-free (AR-01): `commit-batch.ts` gathers the computed
 * quantities (a ledger replay, already available there) and the B3 figures
 * (the staged Posição rows) and hands both here. Nothing here queries
 * anything, which is what makes the attribution heuristic testable against
 * hand-built scenarios without a database.
 */

export const DISCREPANCY_CAUSES = [
  /** BR-005-24: the ledger's own history for this asset starts later than it should. */
  'missing_history_before_import_range',
  /** BR-005-24: an unmapped row on this asset is excluded from the replay that produced `computedQuantity`. */
  'unclassified_rows_affecting_asset',
  /**
   * BR-005-24's third named cause. Unlike the two above, nothing in a Posição
   * or Movimentação extract lets this be *positively* detected — it is the
   * label used when the ledger holds *more* than B3 does and neither of the
   * other two signals explains why, which is the shape a split, bonificação
   * or subscription the ledger never recorded tends to leave.
   */
  'uncaptured_corporate_event',
  /** Neither signal applies and the ledger does not hold a surplus — logged honestly rather than guessed. */
  'undetermined',
] as const;
export type DiscrepancyCause = (typeof DISCREPANCY_CAUSES)[number];

export interface ReconciliationInput {
  readonly assetId: AssetId;
  readonly assetCode: string;
  readonly institutionId: InstitutionId | null;
  readonly computedQuantity: Quantity;
  readonly b3Quantity: Quantity;
  /** Null if the ledger has no `active` transaction for this position at all. */
  readonly firstComputedTradeDate: BusinessDate | null;
  /** BR-005-24: at least one `unclassified` row in this batch touches this asset. */
  readonly hasUnclassifiedRowsAffectingAsset: boolean;
}

/** AR-10: quantities are serialised — this report crosses into `import_batches.reconciliation` jsonb. */
export interface Discrepancy {
  readonly assetId: AssetId;
  readonly assetCode: string;
  readonly institutionId: InstitutionId | null;
  readonly computedQuantity: string;
  readonly b3Quantity: string;
  /** `b3Quantity - computedQuantity`, signed — what an accepted adjustment (BR-005-25) would post. */
  readonly difference: string;
  readonly cause: DiscrepancyCause;
  /** BR-005-25: set once the user has accepted B3's figure via an adjustment transaction. */
  readonly resolved: boolean;
}

export const RECONCILIATION_STATUSES = ['reconciled', 'discrepancies_found'] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

export interface ReconciliationReport {
  readonly asOf: BusinessDate;
  readonly discrepancies: readonly Discrepancy[];
  readonly status: ReconciliationStatus;
}

function attributeCause(input: ReconciliationInput): DiscrepancyCause {
  if (input.hasUnclassifiedRowsAffectingAsset) return 'unclassified_rows_affecting_asset';

  // BR-005-24: the ledger holds *less* than B3 does — either no history for
  // this asset at all, or history that starts too late to have picked up
  // everything B3 knows about.
  const deficit = input.b3Quantity.comparedTo(input.computedQuantity) > 0;
  if (input.firstComputedTradeDate === null || deficit) {
    return 'missing_history_before_import_range';
  }

  // The ledger holds *more* than B3 does, with no unmapped row to blame — the
  // shape an unrecorded split/bonificação/subscription leaves.
  const surplus = input.computedQuantity.comparedTo(input.b3Quantity) > 0;
  if (surplus) return 'uncaptured_corporate_event';

  return 'undetermined';
}

/**
 * BR-005-22/23: a position with `computedQuantity === b3Quantity` is not a
 * discrepancy at all and is omitted — BR-005-23's "lists per asset: computed,
 * B3, difference" is a list of what disagrees, not a full reconciliation
 * ledger of every holding.
 */
export function reconcilePositions(
  asOf: BusinessDate,
  inputs: readonly ReconciliationInput[],
): ReconciliationReport {
  const discrepancies: Discrepancy[] = [];
  for (const input of inputs) {
    if (input.computedQuantity.equals(input.b3Quantity)) continue;
    discrepancies.push({
      assetId: input.assetId,
      assetCode: input.assetCode,
      institutionId: input.institutionId,
      computedQuantity: input.computedQuantity.toString(),
      b3Quantity: input.b3Quantity.toString(),
      difference: input.b3Quantity.minus(input.computedQuantity).toString(),
      cause: attributeCause(input),
      resolved: false,
    });
  }
  return {
    asOf,
    discrepancies,
    status: discrepancies.length === 0 ? 'reconciled' : 'discrepancies_found',
  };
}
