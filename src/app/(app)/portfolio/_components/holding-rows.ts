import type { Money as MoneyValue, Quantity } from '@/core/shared/money';
import type { CompositionReport } from '@/core/reporting/composition/ports';
import type { EvaluatedState } from '@/core/opportunity/ports';
import type { AssetId } from '@/core/shared/ids';
import { currencyText, formatPercent, formatQuantity } from '@/i18n/format';
import type {
  Cell,
  HoldingRow,
  HoldingsTableLabels,
} from '@/app/(app)/portfolio/composition/_components/HoldingsTable';

/**
 * SPEC-015 BR-015-02 — the holdings table's rows and labels, shared by
 * Patrimônio and Composição (SPEC-022 BR-022-02), so the one asset reads the
 * same figures, ranks and markers on both tabs.
 *
 * Moved out of the Composição page with #208; the reasoning below is SPEC-015's.
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * `CompositionRow[]` as the rows the Client Component needs — see
 * `HoldingsTable.tsx` for why `Money` stops here.
 *
 * Built for the whole table at once rather than row by row, because a **rank**
 * is a property of a column, not of a cell: it can only be known once every
 * row's figure has been compared against every other. That comparison happens
 * here, on the server, with exact `Money.comparedTo`.
 */
export function holdingRows(
  rows: readonly CompositionReport['rows'][number][],
  watchStates: ReadonlyMap<AssetId, EvaluatedState>,
  t: Translate,
  tc: Translate,
  tw: Translate,
  masked: boolean,
): HoldingRow[] {
  const quantity = rankOf(rows, (row) => row.quantity);
  const averagePrice = rankOf(rows, (row) => row.averagePrice);
  const currentPrice = rankOf(rows, (row) => row.currentPrice);
  const value = rankOf(rows, (row) => row.value);
  const share = rankOf(rows, (row) => row.share);
  const unrealizedGain = rankOf(rows, (row) => row.unrealizedGain);
  const currency = currencyText(masked);

  return rows.map((row, index) => ({
    id: row.assetId,
    code: row.assetCode,
    name: row.assetName,
    assetClass: t(`assetClass.${row.assetClass}`),
    // BR-015-03 / DL-015-04: never dropped, and never blank either.
    sector: row.sector ?? t('group.notClassified'),
    quantity: cell(row.quantity, formatQuantity, quantity[index]),
    // SPEC-022 BR-022-24: amounts are masked here, on the server; the
    // quantity and the share stay (DL-022-07). Ranks survive, so a masked
    // column still sorts — an order is not an amount.
    averagePrice: cell(row.averagePrice, currency, averagePrice[index], masked),
    currentPrice: cell(row.currentPrice, currency, currentPrice[index], masked),
    value: cell(row.value, currency, value[index], masked),
    share: cell(row.share, formatPercent, share[index]),
    unrealizedGain: cell(row.unrealizedGain, currency, unrealizedGain[index], masked),
    concentrated: row.concentrated,
    estimated: row.estimated,
    costEstimated: row.costEstimated,
    /*
     * BR-018-19 — `null` for a holding with no rule, which is most of them.
     * The label and the title are resolved here, on the server, from the same
     * `watch.*` catalogue entries `/watch` itself renders (AR-44), so the two
     * screens cannot describe the same state in two different words.
     */
    ...watchCells(watchStates.get(row.assetId), tc, tw),
  }));
}

/** The table's labels, from the same catalogue entries on both tabs (AR-44). */
export function holdingsTableLabels(
  report: CompositionReport,
  t: Translate,
  tc: Translate,
  tCommon: Translate,
): HoldingsTableLabels {
  return {
    code: tc('holdings.code'),
    state: tc('holdings.state'),
    assetClass: tc('holdings.assetClass'),
    sector: tc('holdings.sector'),
    quantity: tc('holdings.quantity'),
    averagePrice: tc('holdings.averagePrice'),
    currentPrice: tc('holdings.currentPrice'),
    value: tc('holdings.value'),
    share: tc('holdings.share'),
    unrealizedGain: tc('holdings.unrealizedGain'),
    caption: tc('holdings.caption'),
    concentrated: tc('concentration.badge', { threshold: report.concentration.thresholdPct }),
    concentratedTitle: tc('concentration.explanation', {
      threshold: report.concentration.thresholdPct,
    }),
    estimated: tCommon('estimated'),
    estimatedTitle: t('estimate.explanation'),
    costEstimated: tCommon('estimated'),
    costEstimatedTitle: t('markers.costEstimated.explanation'),
    sortBy: tc('holdings.sortBy', { column: '{column}' }),
    sortField: tc('holdings.sortField'),
    sortAscending: tc('holdings.sortAscending'),
    sortDescending: tc('holdings.sortDescending'),
    filterPlaceholder: tc('holdings.filterPlaceholder'),
  };
}

/**
 * Each row's position in one column's ascending order, or `undefined` where
 * that row has no figure in this column.
 *
 * Ties keep their input order, which is the value-descending order the domain
 * folded them in — so two equal holdings do not swap places when the table is
 * sorted by a third column and back.
 */
function rankOf<T extends MoneyValue | Quantity>(
  rows: readonly CompositionReport['rows'][number][],
  pick: (row: CompositionReport['rows'][number]) => T | null,
): readonly (number | undefined)[] {
  const present = rows
    .map((row, index) => ({ index, figure: pick(row) }))
    .filter((entry): entry is { index: number; figure: T } => entry.figure !== null)
    .sort((a, b) => a.figure.comparedTo(b.figure as never));

  const ranks: (number | undefined)[] = rows.map(() => undefined);
  present.forEach((entry, rank) => {
    ranks[entry.index] = rank;
  });
  return ranks;
}

function cell<T extends MoneyValue | Quantity>(
  figure: T | null,
  format: (value: T) => string,
  rank: number | undefined,
  masked = false,
): Cell {
  return figure === null
    ? // An em dash and no rank — see `Cell.rank`, which sorts it last in both
      // directions rather than letting it pass for zero.
      { text: '—', rank: undefined, negative: false }
    : { text: format(figure), rank, negative: figure.isNegative(), masked };
}

/**
 * SPEC-018 BR-018-18 — the badge's text, and the sentence behind it.
 *
 * The title deliberately says whose rule this is rather than what to do about
 * it: this table already carries the one flag in the product that comes close
 * to an opinion (BR-015-06's concentration badge), and a state that read as a
 * recommendation here would be the product volunteering a view on an asset,
 * which SPEC-018 exists not to do. The full wording — which bound matched and
 * at what threshold — lives on `/watch`, where there is room to state the
 * user's own numbers back to them.
 */
function watchCells(
  state: EvaluatedState | undefined,
  tc: Translate,
  tw: Translate,
): Pick<HoldingRow, 'opportunityState' | 'opportunityStateLabel' | 'opportunityStateTitle'> {
  if (state === undefined) {
    return { opportunityState: null, opportunityStateLabel: '', opportunityStateTitle: '' };
  }
  return {
    opportunityState: state,
    opportunityStateLabel: tw(`stateLabel.${state}`),
    opportunityStateTitle: tc('holdings.stateTitle'),
  };
}
