import { BusinessDate } from '@/core/shared/clock';
import { domainError, type DomainError } from '@/core/shared/domain-error';
import type { AssetId } from '@/core/shared/ids';
import type { Money, Quantity } from '@/core/shared/money';
import { err, ok, type Result } from '@/core/shared/result';
import { valueFixedIncome } from '@/core/valuation/accrual';
import { valueListed, type ListedValuationMode } from '@/core/valuation/listed';
import { valueTesouro } from '@/core/valuation/tesouro';
import {
  ValuationErrorCode,
  type AssetClass,
  type PriceQuote,
  type ValuationContext,
  type ValuedPosition,
} from '@/core/valuation/ports';

/**
 * SPEC-009 — valuing **holdings you already have**, on a date.
 *
 * This is the half of `valuePortfolioAt` that does not care where the
 * quantities came from. `core/valuation/snapshot.ts` gets them by replaying
 * the ledger, because a snapshot must be reproducible from transactions
 * (BR-009-17). A report gets them from SPEC-007's `positions` cache, because
 * TS-32/DL-011-07 forbid a report replaying five years of ledger per request.
 * Same arithmetic either way, and it must stay the same arithmetic — a report
 * that valued positions by its own slightly different rule would disagree with
 * the snapshot chart on the same screen.
 *
 * Splitting it out is what lets `src/app/(app)/reports/data.ts` value holdings
 * without importing anything ledger-shaped, which the structural check in
 * `tests/structural/reports-read-snapshots.test.ts` enforces.
 */

/**
 * One holding to be valued: what is held, how much, and what it cost.
 *
 * Deliberately not `PositionState` — that type carries replay bookkeeping a
 * valuation has no use for, and depending on it here would drag the ledger
 * back into this file through the type graph.
 */
export interface Holding {
  readonly assetId: AssetId;
  readonly quantity: Quantity;
  /** SPEC-007's `preço médio`. `costBasis` is derived as quantity × this. */
  readonly averageCost: Money;
}

export const LISTED_CLASSES: ReadonlySet<AssetClass> = new Set<AssetClass>([
  'stock',
  'fii',
  'bdr',
  'etf',
]);

export const FIXED_INCOME_CLASSES: ReadonlySet<AssetClass> = new Set<AssetClass>([
  'cdb',
  'lci',
  'lca',
]);

/** The last close on or before `date`, from an ascending array. */
export function closeOnOrBefore(
  history: readonly PriceQuote[],
  date: BusinessDate,
): PriceQuote | null {
  let found: PriceQuote | null = null;
  for (const quote of history) {
    if (BusinessDate.isAfter(quote.date, date)) break;
    found = quote;
  }
  return found;
}

/**
 * BR-009-16 / AC-16 — each holding valued by the method its asset class
 * demands: listed at an observed price, Tesouro Direto at the published sell
 * price, bank paper accrued from its contracted indexer.
 *
 * Holdings closed to zero are dropped rather than valued. They are worth
 * nothing by definition, they carry no price, and keeping them would put a
 * "price unavailable" flag on every asset a user has ever finished selling —
 * noise that would bury the flags that mean something (BR-009-13).
 *
 * **Each holding is valued on its own terms, and callers may pass the same
 * asset more than once.** A report groups by institution, so it passes one
 * holding per (asset, institution) pair; a snapshot aggregates first and
 * passes one per asset. Both are correct because every method here is additive
 * in quantity and cost basis: listed value is quantity × price, and accrual
 * applies a factor to the holding's *own* cost basis. Summing the parts gives
 * the same figure as valuing the whole — which is what makes SPEC-015's
 * per-institution breakdown reconcile with SPEC-013's total (TS-12).
 *
 * `mode` is BR-009-02's guard rail. `historical` never reads an intraday
 * quote; `current` is only ever passed for today.
 */
export function valueHoldingsAt(
  context: ValuationContext,
  holdings: readonly Holding[],
  asOf: BusinessDate,
  mode: ListedValuationMode,
): Result<readonly ValuedPosition[], DomainError> {
  const valued: ValuedPosition[] = [];

  for (const holding of holdings) {
    if (holding.quantity.isZero()) continue;

    const asset = context.assets.get(holding.assetId);
    if (asset === undefined) {
      return err(
        domainError(ValuationErrorCode.ASSET_NOT_FOUND, { assetId: holding.assetId, date: asOf }),
      );
    }

    const common = {
      assetId: holding.assetId,
      quantity: holding.quantity,
      averageCost: holding.averageCost,
      asOf,
    };

    if (LISTED_CLASSES.has(asset.assetClass)) {
      valued.push(
        valueListed({
          ...common,
          assetClass: asset.assetClass,
          mode,
          prices: {
            close: closeOnOrBefore(context.closes.get(holding.assetId) ?? [], asOf),
            latest: context.latest.get(holding.assetId) ?? null,
          },
        }),
      );
    } else if (asset.assetClass === 'tesouro_direto') {
      valued.push(
        valueTesouro({
          ...common,
          sellPrice: closeOnOrBefore(context.closes.get(holding.assetId) ?? [], asOf),
        }),
      );
    } else {
      // cdb | lci | lca — BR-009-07. A missing contract is not an error here;
      // `valueFixedIncome` turns it into a cost-valued, flagged position.
      valued.push(
        valueFixedIncome({
          ...common,
          assetClass: asset.assetClass,
          calendar: context.calendar,
          contract: context.contracts.get(holding.assetId) ?? null,
          cdi: context.cdi,
          ipca: context.ipca,
        }),
      );
    }
  }

  return ok(valued);
}
