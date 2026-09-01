import { getTranslations } from 'next-intl/server';
import { defaultGroupingFor, type GroupNames } from '@/core/reporting/grouping';
import type { GroupKey } from '@/core/reporting/ports';
import type { Money as MoneyValue, Quantity } from '@/core/shared/money';
import type { AllocationShift, CompositionReport } from '@/core/reporting/composition/ports';
import type { EvaluatedState } from '@/core/opportunity/ports';
import type { AssetId } from '@/core/shared/ids';
import { assetClassColor, chartColorAt } from '@/components/charts/palette';
import { formatCurrency, formatDateTime, formatPercent, formatQuantity } from '@/i18n/format';
import { fromSearchParams } from '@/lib/report-url-state';
import { hasFixedIncome } from '@/lib/fixed-income';
import { Controls } from '@/app/(app)/reports/_components/Controls';
import { ReportEmptyState } from '@/app/(app)/reports/_components/ReportEmptyState';
import { ReportNav } from '@/app/(app)/reports/_components/ReportNav';
import { resolveGroupLabel } from '@/app/(app)/reports/_components/GroupLabel';
import { tryUserId } from '@/app/(app)/reports/session';
import { loadComposition } from '@/app/(app)/reports/composition/data';
import { loadWatchStates } from '@/app/(app)/watch/data';
import {
  ShareChart,
  type ShareChartSlice,
} from '@/app/(app)/reports/composition/_components/ShareChart';
import {
  HoldingsTable,
  type Cell,
  type HoldingRow,
} from '@/app/(app)/reports/composition/_components/HoldingsTable';
import { PageShell } from '@/components/patterns/page-shell';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { ErrorState } from '@/components/patterns/error-state';
import { Money } from '@/components/patterns/money';
import { Note } from '@/components/patterns/note';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { List, ListItem } from '@/components/layout/list';
import { ChartLegend } from '@/components/charts/chart-legend';
import { Text } from '@/components/ui/text';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * SPEC-015 — **Composição**.
 *
 * The simplest of the four reports and the most used: a share-of-total ring, a
 * sortable table of every holding, and the one flag in this product that comes
 * close to an opinion — kept informational by BR-015-06 and by the wording in
 * the message catalogue, which is reviewed by a human rather than asserted by
 * a test.
 *
 * Never statically prerendered: one tenant's own holdings, so a cached copy
 * built once would be served to everyone.
 */
export const dynamic = 'force-dynamic';

/**
 * DS-11 — eight distinguishable hues is the ceiling for categorical encoding,
 * and grouping by asset routinely exceeds it. Past this many slices the tail
 * is gathered into "Outros" **in the chart only**: the two tables below list
 * every group and every asset individually, which is the drill-down DS-11 asks
 * for. Recycling the palette instead would put two identically-coloured wedges
 * in one ring, which reads as one group split in half.
 */
const MAX_WEDGES = 8;

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function CompositionPage({ searchParams }: PageProps) {
  const t = await getTranslations('reports');
  const tc = await getTranslations('composicao');
  // SPEC-018 BR-018-19: the badge reuses `/watch`'s own state labels rather
  // than a second set here, so one state never has two names (AR-44).
  const tw = await getTranslations('watch');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell width="wide" title={tc('title')}>
        <EmptyState title={t('signedOut')} />
      </PageShell>
    );
  }

  const raw = await searchParams;
  const params = {
    get: (name: string) => {
      const value = raw[name];
      return typeof value === 'string' ? value : null;
    },
  };

  // Parsed twice on purpose: the default grouping depends on the scope
  // (BR-011-04), and the scope is itself one of the parsed values.
  const provisional = fromSearchParams(params, 'asset_class');
  const state = fromSearchParams(params, defaultGroupingFor(provisional.scope, undefined));

  const { wallets, query, report } = await loadComposition(userId, {
    period: state.period,
    scope: state.scope,
    grouping: state.grouping,
  });

  /*
   * SPEC-018 BR-018-19 — the watch state as a badge in the holdings list.
   * Read after the report rather than inside `loadComposition`: it is not part
   * of the composition report (nothing about a share of *patrimônio* depends
   * on it), and folding it in would put an opportunity read behind SPEC-015's
   * own cache and scope rules. Empty for a user who watches nothing, which is
   * every user until they configure a rule.
   */
  const watchStates = await loadWatchStates(userId);

  const labelOf = (key: GroupKey, names: GroupNames): string => resolveGroupLabel(key, names, t);

  return (
    <PageShell width="wide" title={tc('title')} description={tc('description')}>
      <ReportNav current="/reports/composition" />

      <Controls
        action="/reports/composition"
        period={state.period}
        scope={state.scope}
        grouping={state.grouping}
        wallets={wallets.map((wallet) => ({ walletId: wallet.walletId, name: wallet.name }))}
      />

      {!query.ok ? (
        // BR-011-16: a named, explanatory outcome — never a blank page and
        // never a zero that looks like a real figure.
        <ErrorState
          title={
            query.error.code === 'REPORTING_INVALID_PERIOD_RANGE'
              ? t('period.invalidRange')
              : t('scope.walletNotFound')
          }
        />
      ) : query.value.empty || report === null ? (
        <ReportEmptyState scoped={state.scope.kind === 'wallet'} />
      ) : (
        <Stack gap="lg">
          {/*
            SPEC-008 BR-008-04 / BR-015-13 — the quote timestamp and the delay
            tier, on the screen showing the current values rather than in a
            help page nobody opens. "The product never implies real-time."
          */}
          <Cluster gap="md" align="baseline">
            <Text tone="muted" size="xs">
              {tc('freshness.valuation', { date: report.quotes.valuationAsOf })}
            </Text>
            <Text tone="muted" size="xs">
              {report.quotes.quotedAt === null
                ? tc('freshness.noQuote')
                : tc('freshness.quotedAt', {
                    timestamp: formatDateTime(report.quotes.quotedAt),
                  })}
            </Text>
            <Text tone="muted" size="xs">
              {tc('freshness.delay', { minutes: report.quotes.delayMinutes })}
            </Text>
          </Cluster>

          <Section title={tc('groups.title')} description={tc('groups.description')}>
            <Stack gap="md">
              <ChartOfShares report={report} names={query.value.groupNames} labelOf={labelOf} />
              <GroupsTable report={report} names={query.value.groupNames} labelOf={labelOf} />
            </Stack>
          </Section>

          <Section title={tc('holdings.title')} description={tc('holdings.description')}>
            <HoldingsTable
              rows={holdingRows(report.rows, watchStates, t, tc, tw)}
              labels={{
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
                concentrated: tc('concentration.badge', {
                  threshold: report.concentration.thresholdPct,
                }),
                concentratedTitle: tc('concentration.explanation', {
                  threshold: report.concentration.thresholdPct,
                }),
                estimated: t('estimate.badge'),
                estimatedTitle: t('estimate.explanation'),
                sortBy: tc('holdings.sortBy', { column: '{column}' }),
                sortField: tc('holdings.sortField'),
                sortAscending: tc('holdings.sortAscending'),
                sortDescending: tc('holdings.sortDescending'),
              }}
            />
          </Section>

          {/*
            BR-015-05/06 — gathered where a reader will meet it, and worded so
            it suggests nothing. DL-015-03: a threshold the user set is an
            alarm they configured; a threshold the product picked would be a
            judgement it made, and advice would make it an unlicensed advisor
            (PRD risk R7).
          */}
          <Section
            title={tc('concentration.title')}
            description={tc('concentration.description', {
              threshold: report.concentration.thresholdPct,
            })}
          >
            {report.concentration.flagged.length === 0 ? (
              <Text tone="muted">
                {tc('concentration.none', { threshold: report.concentration.thresholdPct })}
              </Text>
            ) : (
              <List gap="sm">
                {report.rows
                  .filter((row) => row.concentrated)
                  .map((row) => (
                    <ListItem key={row.assetId} separated>
                      <Cluster justify="between" gap="sm">
                        <span className="font-medium">{row.assetCode}</span>
                        <Money value={row.share as MoneyValue} kind="percent" />
                      </Cluster>
                    </ListItem>
                  ))}
              </List>
            )}
          </Section>

          <DriftSection report={report} state={state.grouping} />

          {/* SPEC-009 BR-009-12 / AC-10: fixed income is gross — nothing in
              this product deducts tax, and the figure above must say so where
              it is read. */}
          {hasFixedIncome(report.rows.map((row) => row.assetClass)) && (
            <Note>{t('grossOfTax')}</Note>
          )}
        </Stack>
      )}
    </PageShell>
  );
}

/**
 * BR-015-01/07 — the ring, plus the legend and the text alternative that make
 * it readable to somebody who cannot see it (SPEC-016 BR-016-15).
 *
 * The summary lists **every** slice, including any gathered into "Outros" for
 * the chart: the accessible alternative is not allowed to be the lossy one.
 */
async function ChartOfShares({
  report,
  names,
  labelOf,
}: {
  readonly report: CompositionReport;
  /** From `ReportQueryResult.groupNames` — resolved once, by the framework. */
  readonly names: GroupNames;
  readonly labelOf: (key: GroupKey, names: GroupNames) => string;
}) {
  const tc = await getTranslations('composicao');

  const labelled = report.breakdown.map((slice, index) => ({
    slice,
    label: labelOf(slice.key, names),
    color:
      slice.key.dimension === 'asset_class' && !slice.key.synthetic
        ? assetClassColor(slice.key.id as never)
        : chartColorAt(index),
  }));

  const head = labelled.slice(0, MAX_WEDGES - 1);
  const tail = labelled.slice(MAX_WEDGES - 1);

  const wedges: ShareChartSlice[] = [
    ...head.map(({ slice, label, color }) => ({
      key: slice.key.id,
      label,
      color,
      value: plot(slice.totals.value),
      shareText: shareText(slice.share),
    })),
    ...(tail.length === 0
      ? []
      : [
          {
            key: '__others__',
            label: tc('chart.others'),
            color: chartColorAt(MAX_WEDGES - 1),
            value: tail.reduce((acc, entry) => acc + plot(entry.slice.totals.value), 0),
            shareText: shareText(null),
          },
        ]),
  ];

  return (
    <>
      <ShareChart
        title={tc('chart.title')}
        slices={wedges}
        summary={
          <>
            <p>{tc('chart.summary')}</p>
            <ul>
              {labelled.map(({ slice, label }) => (
                <li key={slice.key.id}>
                  {label}: {shareText(slice.share)}
                </li>
              ))}
            </ul>
            {tail.length > 0 && <p>{tc('chart.othersSummary')}</p>}
          </>
        }
      />
      <ChartLegend entries={wedges.map((wedge) => ({ label: wedge.label, color: wedge.color }))} />
    </>
  );
}

/**
 * The chart's own figures as a table — BR-016-16's "every chart is available
 * as text or a table", and the drill-down DS-11 asks for when the ring
 * gathers its tail.
 */
async function GroupsTable({
  report,
  names,
  labelOf,
}: {
  readonly report: CompositionReport;
  readonly names: GroupNames;
  readonly labelOf: (key: GroupKey, names: GroupNames) => string;
}) {
  const tc = await getTranslations('composicao');

  return (
    <Table>
      <TableCaption className="sr-only">{tc('chart.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{tc('groups.group')}</TableHead>
          <TableHead scope="col" className="text-right">
            {tc('groups.value')}
          </TableHead>
          <TableHead scope="col" className="text-right">
            {tc('groups.share')}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {report.breakdown.map((slice) => (
          <TableRow key={slice.key.id}>
            <TableCell className="py-row">{labelOf(slice.key, names)}</TableCell>
            <TableCell className="py-row text-right">
              <Money value={slice.totals.value} />
            </TableCell>
            <TableCell className="py-row text-right tabular-nums">
              {shareText(slice.share)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableHead scope="row" className="py-row text-left">
            {tc('groups.total')}
          </TableHead>
          <TableCell className="py-row text-right">
            <Money value={report.total.value} />
          </TableCell>
          <TableCell className="py-row text-right tabular-nums">100%</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  );
}

/**
 * BR-015-04 — the shift, or the named reason there is none.
 *
 * The refusal is rendered as prose rather than hidden: SPEC-012 and SPEC-013
 * both say on screen why a snapshot-derived figure is missing, because a
 * silently absent chart reads as "you held nothing".
 */
async function DriftSection({
  report,
  state,
}: {
  readonly report: CompositionReport;
  readonly state: string;
}) {
  const t = await getTranslations('reports');
  const tc = await getTranslations('composicao');

  if (report.drift.kind === 'unavailable') {
    return (
      <Section title={tc('drift.title')}>
        <Note>
          {report.drift.reason === 'NO_HISTORICAL_BREAKDOWN'
            ? tc('drift.unavailable.NO_HISTORICAL_BREAKDOWN', {
                grouping: t(`grouping.${state}`),
              })
            : tc(`drift.unavailable.${report.drift.reason}`)}
        </Note>
      </Section>
    );
  }

  return (
    <Section title={tc('drift.title')} description={tc('drift.description')}>
      <Table>
        <TableCaption className="sr-only">{tc('drift.caption')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{tc('drift.group')}</TableHead>
            <TableHead scope="col" className="text-right">
              {tc('drift.opening')}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {tc('drift.closing')}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {tc('drift.change')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {report.drift.value.map((shift: AllocationShift) => (
            <TableRow key={shift.key.id}>
              <TableCell className="py-row">{t(`assetClass.${shift.key.id}`)}</TableCell>
              <TableCell className="py-row text-right">
                <Money value={shift.opening} kind="percent" />
              </TableCell>
              <TableCell className="py-row text-right">
                <Money value={shift.closing} kind="percent" />
              </TableCell>
              <TableCell className="py-row text-right">
                <Money value={shift.change} kind="percent" signed />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}

/**
 * The server/client boundary for chart geometry. `Money` never crosses it —
 * see `ShareChart.tsx`'s header. Every figure a user *reads* on this page is
 * rendered from `Money` on the server.
 */
const plot = (value: MoneyValue): number => Number(value.toString());

/** A share that does not exist renders as an em dash, never as `0,00 %`. */
function shareText(share: MoneyValue | null): string {
  return share === null ? '—' : formatPercent(share);
}

/**
 * `CompositionRow[]` as the rows the Client Component needs — see
 * `HoldingsTable.tsx` for why `Money` stops here.
 *
 * Built for the whole table at once rather than row by row, because a **rank**
 * is a property of a column, not of a cell: it can only be known once every
 * row's figure has been compared against every other. That comparison happens
 * here, on the server, with exact `Money.comparedTo`.
 */
function holdingRows(
  rows: readonly CompositionReport['rows'][number][],
  watchStates: ReadonlyMap<AssetId, EvaluatedState>,
  t: (key: string) => string,
  tc: (key: string) => string,
  tw: (key: string) => string,
): HoldingRow[] {
  const quantity = rankOf(rows, (row) => row.quantity);
  const averagePrice = rankOf(rows, (row) => row.averagePrice);
  const currentPrice = rankOf(rows, (row) => row.currentPrice);
  const value = rankOf(rows, (row) => row.value);
  const share = rankOf(rows, (row) => row.share);
  const unrealizedGain = rankOf(rows, (row) => row.unrealizedGain);

  return rows.map((row, index) => ({
    id: row.assetId,
    code: row.assetCode,
    name: row.assetName,
    assetClass: t(`assetClass.${row.assetClass}`),
    // BR-015-03 / DL-015-04: never dropped, and never blank either.
    sector: row.sector ?? t('group.notClassified'),
    quantity: cell(row.quantity, formatQuantity, quantity[index]),
    averagePrice: cell(row.averagePrice, formatCurrency, averagePrice[index]),
    currentPrice: cell(row.currentPrice, formatCurrency, currentPrice[index]),
    value: cell(row.value, formatCurrency, value[index]),
    share: cell(row.share, formatPercent, share[index]),
    unrealizedGain: cell(row.unrealizedGain, formatCurrency, unrealizedGain[index]),
    concentrated: row.concentrated,
    estimated: row.estimated,
    /*
     * BR-018-19 — `null` for a holding with no rule, which is most of them.
     * The label and the title are resolved here, on the server, from the same
     * `watch.*` catalogue entries `/watch` itself renders (AR-44), so the two
     * screens cannot describe the same state in two different words.
     */
    ...watchCells(watchStates.get(row.assetId), tc, tw),
  }));
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
): Cell {
  return figure === null
    ? // An em dash and no rank — see `Cell.rank`, which sorts it last in both
      // directions rather than letting it pass for zero.
      { text: '—', rank: undefined, negative: false }
    : { text: format(figure), rank, negative: figure.isNegative() };
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
  tc: (key: string) => string,
  tw: (key: string) => string,
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
