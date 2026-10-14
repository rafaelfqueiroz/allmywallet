import { getTranslations } from 'next-intl/server';
import { defaultGroupingFor } from '@/core/reporting/grouping';
import { chartColorAt } from '@/components/charts/palette';
import { stackedTable } from '@/core/reporting/portfolio-value/series';
import type { AllocationShift } from '@/core/reporting/composition/ports';
import type {
  GrowthDecomposition,
  MonthlyContribution,
  StackedBand,
  ValuePoint,
} from '@/core/reporting/portfolio-value/ports';
import { fromSearchParams } from '@/lib/report-url-state';
import { hasFixedIncome } from '@/lib/fixed-income';
import { Controls, reportExportHref } from '@/app/(app)/reports/_components/Controls';
import { ReportEmptyState } from '@/app/(app)/reports/_components/ReportEmptyState';
import { ReportsFrame } from '@/app/(app)/reports/_components/ReportsFrame';
import { tryUserId } from '@/lib/session';
import { loadPatrimonio } from '@/app/(app)/reports/patrimonio-data';
import { basisOf, plot, toValueChartPoints } from '@/app/(app)/reports/value-series';
import { ValueChart } from '@/app/(app)/reports/_components/ValueChart';
import { ContributionChart } from '@/app/(app)/reports/_components/ContributionChart';
import { StackedChart } from '@/app/(app)/reports/_components/StackedChart';
import { PageShell } from '@/app/page-shell';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { ErrorState } from '@/components/patterns/error-state';
import { StatCard } from '@/components/patterns/stat-card';
import { Money } from '@/app/money';
import { loadHideValues, useHideValues } from '@/app/hide-values';
import { concealSeries } from '@/app/chart-series';
import { Note } from '@/components/patterns/note';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Grid } from '@/components/layout/grid';
import { Badge } from '@/components/ui/badge';
import { Text } from '@/components/ui/text';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableColGroup,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { columnWidth } from '@/components/patterns/data-table-columns';
import { formatBusinessDate } from '@/i18n/format';
import { NodeTable, type NodeColumn } from '@/components/patterns/node-table';
import { ranksOf } from '@/lib/rank-keys';
import { tableLabels, type ReportTableLabels } from '@/app/(app)/reports/_components/table-labels';

/**
 * SPEC-013 — **Relatórios › Evolução patrimonial** (SPEC-022 BR-022-03), the
 * destination's first tab and therefore its root, `/reports`. The old
 * `/reports/patrimonio` redirects here (`legacy-redirects.ts`).
 *
 * Composition drift over the period (SPEC-015 BR-015-04) is shown here, as the
 * series stacked by grouping (BR-013-05) and the share at each end of the
 * period: drift needs a period, and Composição moved to Portfólio, which takes
 * none (DL-022-02).
 *
 * AR-46: the pt-BR interface says *Patrimônio*, and the English name is
 * Portfolio Value, never "Net Worth" — net worth is assets minus liabilities
 * and this product tracks no liabilities (DL-013-01).
 *
 * Never statically prerendered: one tenant's own figures, so a cached copy
 * built once would be served to everyone.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PatrimonioPage({ searchParams }: PageProps) {
  const t = await getTranslations('reports');
  const tp = await getTranslations('patrimonio');
  const tCommon = await getTranslations('common');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell title={t('title')}>
        <EmptyState title={t('signedOut')} />
      </PageShell>
    );
  }

  // SPEC-022 BR-022-24: the charts' coordinates are rescaled when masked.
  const masked = await loadHideValues();
  const raw = await searchParams;
  const params = {
    get: (name: string) => {
      const value = raw[name];
      return typeof value === 'string' ? value : null;
    },
  };

  // Parsed twice for the same reason `/reports` does it: the default grouping
  // depends on the scope (BR-011-04), and the scope is one of the parsed
  // values.
  const provisional = fromSearchParams(params, 'asset_class');
  const defaultGrouping = defaultGroupingFor(provisional.scope, undefined);
  const state = fromSearchParams(params, defaultGrouping);

  const { wallets, query, report, closeGapDates } = await loadPatrimonio(userId, state);

  /**
   * SPEC-011 BR-011-02 / ADR-002 — the snapshot-derived half of the report,
   * narrowed once.
   *
   * The domain returns each of these as a `SnapshotDerived` union because at
   * wallet scope there is no wallet-grain history to compute them from
   * (`core/reporting/portfolio-value/report.ts` has the arithmetic that used
   * to come out of pairing them with a scoped total). They are narrowed
   * together rather than one at a time because they share a single cause, and
   * one explanation for five missing charts reads better than five copies of
   * it.
   */
  const invested =
    report !== null && report.headline.invested.kind === 'available'
      ? report.headline.invested.value
      : null;

  const history =
    report !== null &&
    report.series.kind === 'available' &&
    report.decomposition.kind === 'available' &&
    report.monthlyContributions.kind === 'available'
      ? {
          series: report.series.value,
          decomposition: report.decomposition.value,
          contributions: report.monthlyContributions.value,
        }
      : null;

  return (
    <ReportsFrame
      wallets={wallets.map((wallet) => ({ walletId: wallet.walletId, name: wallet.name }))}
      description={tp('description')}
    >
      <Controls
        action="/reports"
        period={state.period}
        scope={state.scope}
        grouping={state.grouping}
        exportHref={
          query.ok && !query.value.empty ? reportExportHref(state, defaultGrouping) : undefined
        }
      />

      {!query.ok ? (
        <ErrorState
          title={
            query.error.code === 'REPORTING_INVALID_PERIOD_RANGE'
              ? t('period.invalidRange')
              : t('scope.walletNotFound')
          }
        />
      ) : query.value.empty || report === null ? (
        // BR-011-16 / AC — an empty scope explains itself rather than showing
        // R$ 0,00, which reads as "your money is worth nothing" instead of
        // "there is nothing here yet".
        <ReportEmptyState scoped={state.scope.kind === 'wallet'} />
      ) : (
        <Stack gap="xl">
          {/* BR-013-13 — both dates, because they answer different questions:
              when the figures were valued, and how old the custody data behind
              them is. */}
          <Cluster gap="md">
            <Text tone="muted" size="xs">
              {tp('freshness.valuation', { date: report.freshness.valuationAsOf })}
            </Text>
            <Text tone="muted" size="xs">
              {report.freshness.lastImportAt === null
                ? tp('freshness.neverImported')
                : tp('freshness.lastImport', { date: report.freshness.lastImportAt })}
            </Text>
          </Cluster>

          {/* BR-013-04. `currentValue` is the scoped holdings total and holds
              at any scope; the other three come from the snapshot series and
              do not exist at wallet scope (ADR-002) — so they say
              *indisponível* rather than quietly reporting the whole
              portfolio's contributions against one wallet's value. */}
          <Grid cols={4}>
            <StatCard
              label={tp('headline.currentValue')}
              value={<Money value={report.headline.currentValue} />}
              hint={history?.series.at(-1)?.estimated ? tp('estimated.hint') : undefined}
            />
            <StatCard
              label={tp('headline.totalInvested')}
              value={
                invested === null ? (
                  <Unavailable label={tp('unavailable')} />
                ) : (
                  <Money value={invested.totalInvested} />
                )
              }
            />
            <StatCard
              label={tp('headline.absoluteGain')}
              value={
                invested === null ? (
                  <Unavailable label={tp('unavailable')} />
                ) : (
                  <Money value={invested.absoluteGain} signed />
                )
              }
            />
            <StatCard
              label={tp('headline.gain')}
              value={
                invested === null ? (
                  <Unavailable label={tp('unavailable')} />
                ) : invested.gainRatio === null ? (
                  // An undefined ratio, not an infinite one. An em dash says
                  // "not applicable"; "∞%" says something false.
                  <Text as="span" size="lg">
                    {tp('headline.notApplicable')}
                  </Text>
                ) : (
                  <Money value={invested.gainRatio} kind="percent" signed />
                )
              }
            />
          </Grid>

          {history === null ? (
            /**
             * SPEC-011 BR-011-16 / SPEC-013 — **the explanation, once, where
             * five charts used to be.**
             *
             * Everything below this point reads `daily_valuation_snapshots`,
             * which has no wallet dimension (ADR-002). Rendering the
             * portfolio's series under a wallet's heading is what produced a
             * −97,5 % ganho on a carteira nobody had withdrawn from; rendering
             * nothing at all would read as "this carteira has no history",
             * which is a false statement about the user rather than a true one
             * about the product. So it says which figures are missing and why,
             * in one place rather than five times over.
             */
            <EmptyState title={tp('walletScope.title')} description={tp('walletScope.body')} />
          ) : (
            <>
              <Section
                title={tp('chart.title')}
                description={tp(`granularity.${report.granularity}`)}
              >
                <Stack gap="md">
                  <ValueChart
                    masked={masked}
                    title={tp('chart.title')}
                    summary={<SeriesSummary points={history.series} label={tp('chart.summary')} />}
                    // SPEC-021 BR-021-31: a gap day is plotted as a break; the
                    // table below states its figure under its own basis.
                    points={concealSeries(
                      toValueChartPoints(history.series, closeGapDates),
                      ['value'],
                      masked,
                    )}
                  />
                  {history.series.some((point) => point.estimated) && (
                    // BR-013-07 / DL-013-04: the marker sits with the chart, not in
                    // a footnote read once and forgotten.
                    <Badge variant="outline">{tp('estimated.badge')}</Badge>
                  )}
                  {history.series.some((point) => closeGapDates.has(point.date)) && (
                    // SPEC-021 BR-021-31: the break in the line says *where*; this says *why*.
                    <Badge variant="outline">{tp('gap.badge')}</Badge>
                  )}
                </Stack>
              </Section>

              {/* BR-013-02/03 — the report's reason to exist. */}
              <Section
                title={tp('decomposition.title')}
                description={tp('decomposition.description')}
              >
                <DecompositionTable
                  decomposition={history.decomposition}
                  labels={{
                    caption: tp('decomposition.title'),
                    driver: tp('decomposition.driver'),
                    amount: tp('decomposition.amount'),
                    opening: tp('decomposition.opening'),
                    contributions: tp('decomposition.contributions'),
                    priceChange: tp('decomposition.priceChange'),
                    earnings: tp('decomposition.earnings'),
                    closing: tp('decomposition.closing'),
                  }}
                />
              </Section>

              <Section
                title={tp('contributions.title')}
                description={tp('contributions.description')}
              >
                <ContributionChart
                  masked={masked}
                  title={tp('contributions.title')}
                  summary={
                    <ContributionSummary
                      bars={history.contributions}
                      label={tp('contributions.summary')}
                    />
                  }
                  bars={concealSeries(
                    history.contributions.map((bar) => ({
                      month: bar.month,
                      amount: plot(bar.amount),
                    })),
                    ['amount'],
                    masked,
                  )}
                />
              </Section>

              {report.stacked.kind === 'available' && (
                // BR-013-05 / #63 — the composition bands. Previously computed
                // by `stackedSeries` and rendered by nothing, so the one
                // grouping that *can* be answered drew no chart while the other
                // four at least explained themselves.
                <Section title={tp('stacked.title')} description={tp('stacked.description')}>
                  <StackedComposition
                    bands={report.stacked.bands}
                    labels={{
                      title: tp('stacked.title'),
                      summary: tp('stacked.summary'),
                      caption: tp('stacked.caption'),
                      date: tp('table.date'),
                      band: t(`grouping.${report.stacked.grouping}`),
                      value: tp('stacked.value'),
                      share: tp('stacked.share'),
                    }}
                    table={tableLabels(t, {
                      caption: tp('stacked.caption'),
                      noun: tp('stacked.noun'),
                    })}
                    nameOf={(key) => t(`assetClass.${key}`)}
                  />
                </Section>
              )}

              {report.stacked.kind === 'unavailable' && (
                // The honest refusal, surfaced. An empty stacked chart would read
                // as "you held nothing" — false about the portfolio rather than
                // true about the product.
                <Section title={tp('stacked.title')}>
                  <Text tone="muted">
                    {tp('stacked.unavailable', {
                      grouping: t(`grouping.${report.stacked.grouping}`),
                    })}
                  </Text>
                </Section>
              )}

              {/* SPEC-015 BR-015-04 / SPEC-022 BR-022-03 — the bands above
                  show the shape; this states the share at each end. A grouping
                  the snapshot does not decompose was already explained by the
                  stacked section, so it is not explained twice. */}
              {(report.drift.kind === 'available' ||
                report.drift.reason !== 'NO_HISTORICAL_BREAKDOWN') && (
                <Section title={tp('drift.title')} description={tp('drift.description')}>
                  {report.drift.kind === 'available' ? (
                    <DriftTable
                      shifts={report.drift.value}
                      labels={{
                        caption: tp('drift.caption'),
                        group: tp('drift.group'),
                        opening: tp('drift.opening'),
                        closing: tp('drift.closing'),
                        change: tp('drift.change'),
                      }}
                      nameOf={(key) => t(`assetClass.${key}`)}
                    />
                  ) : (
                    <Text tone="muted">{tp(`drift.unavailable.${report.drift.reason}`)}</Text>
                  )}
                </Section>
              )}

              {/* SPEC-016 BR-016-16 — the chart, as a table. Not a fallback: the
                  exact figures are here and only the shape is in the chart. */}
              <Section title={tp('table.title')}>
                <SeriesTable
                  points={history.series}
                  gapDates={closeGapDates}
                  labels={{
                    caption: tp('table.title'),
                    date: tp('table.date'),
                    value: tp('table.value'),
                    basis: tp('table.basis'),
                    observed: tp('table.observed'),
                    estimated: tCommon('estimated'),
                    gap: tp('table.gap'),
                  }}
                  table={tableLabels(t, { caption: tp('table.title'), noun: tp('table.noun') })}
                />
              </Section>
            </>
          )}

          {/* SPEC-009 BR-009-12 / AC-10: every fixed-income figure declares
              itself gross of IR and IOF. It sits at the foot of the report
              rather than beside one figure because the disclosure is about the
              whole valuation, not about a single row. */}
          {hasFixedIncome(
            query.value.report.groups.flatMap((group) =>
              group.holdings.map((holding) => holding.assetClass),
            ),
          ) && <Note>{t('grossOfTax')}</Note>}
        </Stack>
      )}
    </ReportsFrame>
  );
}

/**
 * A figure the domain refused to produce, in the same words the Rentabilidade
 * report uses for the same situation (BR-011-06: same semantics everywhere).
 * Never `R$ 0,00` — a zero is a claim about the money.
 */
function Unavailable({ label }: { readonly label: string }) {
  return (
    <Text as="span" size="lg">
      {label}
    </Text>
  );
}

/** The chart's text equivalent: first, last and extent, in words. */
function SeriesSummary({ points, label }: { points: readonly ValuePoint[]; label: string }) {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined) return null;
  return (
    <span>
      {label}
      {': '}
      {first.date} <Money value={first.value} /> — {last.date} <Money value={last.value} />
    </span>
  );
}

function ContributionSummary({
  bars,
  label,
}: {
  bars: readonly MonthlyContribution[];
  label: string;
}) {
  return (
    <ul>
      <li>{label}</li>
      {bars.map((bar) => (
        <li key={bar.month}>
          {bar.month} <Money value={bar.amount} signed />
        </li>
      ))}
    </ul>
  );
}

/**
 * SPEC-022 BR-022-18 — five fixed rows (the opening balance, three drivers and
 * the closing balance), so this table does not paginate. It still takes the
 * standard's fixed layout and kinds, so hiding the amounts (BR-022-24) moves no
 * column.
 */
function DecompositionTable({
  decomposition,
  labels,
}: {
  decomposition: GrowthDecomposition;
  labels: Record<
    | 'caption'
    | 'driver'
    | 'amount'
    | 'opening'
    | 'contributions'
    | 'priceChange'
    | 'earnings'
    | 'closing',
    string
  >;
}) {
  const rows = [
    { key: 'opening', label: labels.opening, value: decomposition.opening, signed: false },
    {
      key: 'contributions',
      label: labels.contributions,
      value: decomposition.netContributions,
      signed: true,
    },
    {
      key: 'priceChange',
      label: labels.priceChange,
      value: decomposition.priceChange,
      signed: true,
    },
    { key: 'earnings', label: labels.earnings, value: decomposition.earnings, signed: true },
    { key: 'closing', label: labels.closing, value: decomposition.closing, signed: false },
  ] as const;

  return (
    <Table fixed>
      <TableCaption className="sr-only">{labels.caption}</TableCaption>
      <TableColGroup widths={[columnWidth('text'), columnWidth('money')]} />
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{labels.driver}</TableHead>
          <TableHead scope="col" className="text-right">
            {labels.amount}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.key}>
            <TableHead scope="row" className="text-left font-normal">
              {row.label}
            </TableHead>
            <TableCell className="text-right tabular-nums">
              <Money value={row.value} signed={row.signed} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * SPEC-016 BR-016-16 — the chart's figures, one row per date of the series.
 *
 * SPEC-022 BR-022-18: the history grows by a row a day, so it is the paginated,
 * sortable table, newest first — the date a reader opens it for. The CSV export
 * (`Controls`) is built from the report's query, not from this table, so it
 * keeps exporting the whole period whatever page is on screen.
 */
function SeriesTable({
  points,
  gapDates,
  labels,
  table,
}: {
  points: readonly ValuePoint[];
  gapDates: ReadonlySet<string>;
  labels: Record<'caption' | 'date' | 'value' | 'basis' | 'observed' | 'estimated' | 'gap', string>;
  table: ReportTableLabels;
}) {
  const columns: NodeColumn[] = [
    { id: 'date', header: labels.date, kind: 'date', sortable: true },
    { id: 'value', header: labels.value, kind: 'money', sortable: true },
    // The gap day's sentence is the longest cell in the report; it truncates
    // with its full text on demand (DS-67) rather than widening the column.
    { id: 'basis', header: labels.basis, kind: 'text', width: 24, sortable: true },
  ];
  const valueRanks = ranksOf(points, (point) => point.value);

  return (
    <NodeTable
      columns={columns}
      {...table}
      paramPrefix="history"
      sort={{ id: 'date', desc: true }}
      rows={points.map((point, index) => {
        // SPEC-021 BR-021-31: a carried-forward gap day is never "observed".
        const basis = labels[basisOf(point, gapDates)];
        return {
          cells: {
            date: formatBusinessDate(point.date),
            value: <Money value={point.value} />,
            basis,
          },
          keys: { date: point.date, value: valueRanks[index], basis },
        };
      })}
    />
  );
}

/**
 * SPEC-013 BR-013-05 / SPEC-016 BR-016-16 — the composition bands, as a chart
 * and as the table that carries the same figures.
 *
 * Both read `stackedTable`'s days, which give every date every band (absent
 * means zero: the class was not held) — the chart because Recharts stacks by
 * row and a missing key leaves a hole in the stack, the table because a row per
 * class per date is what it lists.
 *
 * SPEC-022 BR-022-41: the table is **one row per date and class** — Data,
 * Classe, Valor, Participação — not a money column per class, which with every
 * class held was wider than the panel.
 */
function StackedComposition({
  bands,
  labels,
  table,
  nameOf,
}: {
  readonly bands: readonly StackedBand[];
  readonly labels: Record<
    'title' | 'summary' | 'caption' | 'date' | 'band' | 'value' | 'share',
    string
  >;
  readonly table: ReportTableLabels;
  readonly nameOf: (key: string) => string;
}) {
  const days = stackedTable(bands);

  // SPEC-022 BR-022-24 — a synchronous component, so the request-cached read.
  const masked = useHideValues();
  const rows = concealSeries(
    days.map((day) => {
      const row: Record<string, string | number> = { date: day.date };
      for (const band of day.bands) row[band.key] = plot(band.value);
      return row;
    }),
    bands.map((band) => band.key),
    masked,
  );

  const legend = bands.map((band, index) => ({
    key: band.key,
    label: nameOf(band.key),
    color: chartColorAt(index),
  }));

  // Date ascending, then the bands' own order — the order the table keeps
  // within a date whichever way the dates are sorted (a stable sort).
  const cells = days.flatMap((day) => day.bands.map((band) => ({ date: day.date, ...band })));
  // Ranks from exact `comparedTo`, never a float (`NodeTable`).
  const valueRanks = ranksOf(cells, (cell) => cell.value);
  const shareRanks = ranksOf(cells, (cell) => cell.share);

  return (
    <Stack gap="md">
      <StackedChart
        masked={masked}
        rows={rows}
        bands={legend}
        title={labels.title}
        summary={labels.summary}
      />
      {/* SPEC-022 BR-022-18: the table that grows with the history, so it
          pages and sorts like the series above. */}
      <NodeTable
        columns={[
          { id: 'date', header: labels.date, kind: 'date', sortable: true },
          { id: 'band', header: labels.band, kind: 'text', sortable: true },
          { id: 'value', header: labels.value, kind: 'money', sortable: true },
          { id: 'share', header: labels.share, kind: 'percent', sortable: true },
        ]}
        {...table}
        paramPrefix="stacked"
        sort={{ id: 'date', desc: true }}
        rows={cells.map((cell, index) => ({
          cells: {
            date: formatBusinessDate(cell.date),
            band: nameOf(cell.key),
            // Zero rather than an em dash: a class absent from a day's snapshot
            // was not held that day, which is a figure, not a gap.
            value: <Money value={cell.value} />,
            share: cell.share === null ? '—' : <Money value={cell.share} kind="percent" />,
          },
          keys: {
            date: cell.date,
            band: nameOf(cell.key),
            value: valueRanks[index],
            share: shareRanks[index],
          },
        }))}
      />
    </Stack>
  );
}

/**
 * SPEC-015 BR-015-04 — each class's share of the portfolio at the baseline
 * and at the end of the period. Shares, not values: a class can be worth more
 * and still hold less of the portfolio, which is the point of the table.
 */
function DriftTable({
  shifts,
  labels,
  nameOf,
}: {
  readonly shifts: readonly AllocationShift[];
  readonly labels: Record<'caption' | 'group' | 'opening' | 'closing' | 'change', string>;
  readonly nameOf: (key: string) => string;
}) {
  return (
    // SPEC-022 BR-022-18: one row per asset class — drift is only computed for
    // that grouping — so this is a bounded table of at most eight rows and does
    // not paginate. Columns are sized for their header, which is the longest
    // thing in them.
    <Table fixed>
      <TableCaption className="sr-only">{labels.caption}</TableCaption>
      <TableColGroup
        widths={[
          columnWidth('text'),
          columnWidth('percent', 20),
          columnWidth('percent', 20),
          columnWidth('percent'),
        ]}
      />
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{labels.group}</TableHead>
          <TableHead scope="col" className="text-right">
            {labels.opening}
          </TableHead>
          <TableHead scope="col" className="text-right">
            {labels.closing}
          </TableHead>
          <TableHead scope="col" className="text-right">
            {labels.change}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {shifts.map((shift) => (
          <TableRow key={shift.key.id}>
            <TableHead scope="row" className="text-left font-normal">
              {nameOf(shift.key.id)}
            </TableHead>
            <TableCell className="text-right tabular-nums">
              <Money value={shift.opening} kind="percent" />
            </TableCell>
            <TableCell className="text-right tabular-nums">
              <Money value={shift.closing} kind="percent" />
            </TableCell>
            <TableCell className="text-right tabular-nums">
              <Money value={shift.change} kind="percent" signed />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
