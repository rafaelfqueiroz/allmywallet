import { Money, sumMoney, sumQuantity } from '@/core/shared/money';
import type { AssetId } from '@/core/shared/ids';
import type { BusinessDate } from '@/core/shared/clock';
import { quantizeToStorageScale } from '@/core/reporting/base-query';
import type { GroupedReport, ReportHolding } from '@/core/reporting/ports';
import type { CompositionSlice, UnflaggedRow } from '@/core/reporting/composition/ports';

/**
 * SPEC-015 BR-015-01/02/07/10 — the two folds the Composition report is made
 * of, and the share arithmetic underneath both.
 */

const ONE = Money.fromString('1');

/**
 * BR-015-10 — "shares sum to 100 % for the scope."
 *
 * **Exactly 100 %, not 99,999999 %**, and the technique is the one
 * `distributeExact` already uses one directory up, for the same reason and
 * against the same hazard. `Money.dividedBy` terminates at 40 significant
 * digits, rounding **down**; every share computed that way is a hair short, so
 * a hundred of them sum to visibly less than the whole. A report whose slices
 * add up to 99,99 % is a report the user has to wonder about, and the missing
 * sliver is a rounding mode rather than a holding — which is the worst
 * possible thing for it to look like.
 *
 * So: the first n−1 shares are computed by division and **the last takes the
 * residual**, `1 − Σ(others)`. The sum is then exact by construction rather
 * than by luck.
 *
 * The parts are quantised to the storage scale before summing, for the reason
 * `quantizeToStorageScale` documents: addition at a fixed significant-digit
 * budget is not associative, so unquantised 40-digit shares sum to different
 * figures in different orders. Each part therefore carries at most half an ulp
 * of error at the eighth decimal place of a *fraction* — a millionth of a
 * percentage point — and the residual absorbs the accumulation.
 *
 * **`null` when the total is zero.** A share of nothing is undefined, not
 * zero. Rendering `0,00 %` next to an asset somebody owns is a figure
 * indistinguishable from a real one, so every share in a report is null
 * together or present together and the screen says why.
 *
 * The caller passes the parts of `total` — that is a precondition of the
 * function, not something it re-checks. `totalsOf` in `base-query.ts` is what
 * produces both, from one array, which is why it cannot be violated here.
 */
export function sharesOf(values: readonly Money[], total: Money): readonly Money[] | null {
  if (total.isZero()) return null;

  const shares: Money[] = [];
  let allocated = Money.zero();
  for (let index = 0; index < values.length - 1; index += 1) {
    // Non-null: `index` is strictly below `values.length`.
    const share = quantizeToStorageScale((values[index] as Money).dividedBy(total.toDecimal()));
    shares.push(share);
    allocated = allocated.plus(share);
  }
  // The residual. This line is the whole point of the function.
  if (values.length > 0) shares.push(ONE.minus(allocated));

  return shares;
}

/**
 * BR-015-01/07 — the chart's slices: SPEC-011's grouping, with each group's
 * share of the scope.
 *
 * **Largest first**, which is the one place this report re-sorts what the
 * framework handed it. `compareGroupKeys` sorts by id for *reproducibility*
 * — two runs of a CSV export must be byte-identical — and says so explicitly:
 * "reports that want a value-ordered view (Composition wants largest-first)
 * re-sort for display". This is that re-sort. Ties fall back to the framework's
 * own order, so the output stays deterministic when two groups are worth the
 * same, which is common on a fresh portfolio where several are worth zero.
 *
 * **Shares are computed after the sort, not before.** The residual above lands
 * on the last element, so computing it in one order and displaying another
 * would move the ulp between renders of the same data.
 */
export function sliceBreakdown(report: GroupedReport): readonly CompositionSlice[] {
  const ordered = [...report.groups].sort(byValueDescending);
  const shares = sharesOf(
    ordered.map((group) => group.totals.value),
    report.total.value,
  );

  return ordered.map((group, index) => ({
    key: group.key,
    totals: group.totals,
    // Non-null: `sharesOf` returns one share per value, or null for all of them.
    share: shares === null ? null : (shares[index] as Money),
  }));
}

function byValueDescending(
  a: { totals: { value: Money } },
  b: { totals: { value: Money } },
): number {
  return b.totals.value.comparedTo(a.totals.value);
}

/**
 * BR-015-02/08/11 — the table's rows: one per **asset**, folded across every
 * institution and wallet slice of it inside the scope.
 *
 * See `ports.ts` for why the table's grain is the asset rather than the
 * selected grouping: average price and current price are properties of an
 * asset, and the "average price of Ações" is not a number.
 *
 * **BR-015-11 needs no code here.** At wallet scope `applyScope` has already
 * dropped every slice belonging to another wallet, so folding what remains
 * yields the *allocated* quantity by construction. A filter at this level
 * would be a second implementation of scope, and the first one to drift.
 */
export function assetRows(
  holdings: readonly ReportHolding[],
  total: Money,
): readonly UnflaggedRow[] {
  const byAsset = new Map<AssetId, ReportHolding[]>();
  for (const holding of holdings) {
    const existing = byAsset.get(holding.assetId);
    if (existing === undefined) byAsset.set(holding.assetId, [holding]);
    else existing.push(holding);
  }

  const folded = [...byAsset.values()].map(foldOneAsset).sort(byRowValueDescending);
  const shares = sharesOf(
    folded.map((row) => row.value),
    total,
  );

  return folded.map((row, index) => ({
    ...row,
    // Non-null: one share per row, or null for all of them.
    share: shares === null ? null : (shares[index] as Money),
  }));
}

/**
 * The identifying fields (`assetCode`, `assetClass`, `sector`, …) are read
 * from the first slice rather than reconciled across all of them: every slice
 * in the group came from the same `AssetDescriptor`, because `buildHoldingSet`
 * copies one descriptor onto every slice of one position. They cannot disagree.
 */
function foldOneAsset(slices: readonly ReportHolding[]): Omit<UnflaggedRow, 'share'> {
  // Non-null: a map value built by push always holds at least one element.
  const first = slices[0] as ReportHolding;

  const quantity = sumQuantity(slices.map((slice) => slice.quantity));
  const value = sumMoney(slices.map((slice) => slice.value));
  const costBasis = sumMoney(slices.map((slice) => slice.costBasis));

  return {
    assetId: first.assetId,
    assetCode: first.assetCode,
    assetName: first.assetName,
    assetClass: first.assetClass,
    sector: first.sector,
    quantity,
    value,
    costBasis,
    // A price per zero units is undefined, not infinite. Reachable when a
    // negative Unassigned remainder cancels a positive allocation exactly —
    // `walletSlicesFor` passes that contradiction through rather than clamping
    // it, precisely so it stays visible instead of quietly changing a total.
    averagePrice: quantity.isZero() ? null : costBasis.dividedBy(quantity),
    currentPrice: quantity.isZero() ? null : value.dividedBy(quantity),
    // BR-015-08 — see `CompositionRow.unrealizedGain` for why this is a
    // subtraction rather than the spec's literal `value − qty × avg`.
    unrealizedGain: value.minus(costBasis),
    // BR-015-09 / BR-011-15: one accrued slice is enough to mark the row.
    estimated: slices.some((slice) => slice.estimated),
    carriedForward: slices.some((slice) => slice.carriedForward),
    priceDate: latestPriceDate(slices),
    // First non-null wins: every slice of one asset was priced by the same
    // path, so these are equal wherever they are set at all.
    needsAttention: slices.find((slice) => slice.needsAttention !== null)?.needsAttention ?? null,
    basis: slices.find((slice) => slice.basis !== null)?.basis ?? null,
  };
}

/**
 * `BusinessDate` is a branded `YYYY-MM-DD` string, so lexical order *is*
 * chronological order — which is the whole reason the format was chosen.
 */
function latestPriceDate(slices: readonly ReportHolding[]): BusinessDate | null {
  let latest: BusinessDate | null = null;
  for (const slice of slices) {
    if (slice.priceDate !== null && (latest === null || slice.priceDate > latest)) {
      latest = slice.priceDate;
    }
  }
  return latest;
}

/**
 * Largest first, ties broken by the asset's code so a portfolio holding two
 * equal positions renders in the same order on every request.
 *
 * **No `=== 0` arm on the code comparison.** `assetCode` is unique in the
 * catalog and these rows are one per asset, so two rows cannot share one — the
 * arm would be a branch no test could ever reach, which is worse than leaving
 * it out: it would sit here looking like a handled case, and it would block
 * the 100 %-branch gate this directory is held to (TS-28).
 */
function byRowValueDescending(
  a: { readonly value: Money; readonly assetCode: string },
  b: { readonly value: Money; readonly assetCode: string },
): number {
  const byValue = b.value.comparedTo(a.value);
  if (byValue !== 0) return byValue;
  return a.assetCode < b.assetCode ? -1 : 1;
}
