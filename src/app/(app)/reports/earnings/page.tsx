import { getTranslations } from 'next-intl/server';
import { defaultGroupingFor } from '@/core/reporting/grouping';
import type { GroupKey } from '@/core/reporting/ports';
import type { Money as MoneyValue } from '@/core/shared/money';
import type { AssetIncome, EarningsReport, MonthlyIncome } from '@/core/reporting/earnings/ports';
import { fromSearchParams } from '@/lib/report-url-state';
import { Controls } from '@/app/(app)/reports/_components/Controls';
import { ReportEmptyState } from '@/app/(app)/reports/_components/ReportEmptyState';
import { ReportsFrame } from '@/app/(app)/reports/_components/ReportsFrame';
import { resolveGroupLabel } from '@/app/(app)/reports/_components/GroupLabel';
import { tryUserId } from '@/lib/session';
import { loadEarnings } from '@/app/(app)/reports/earnings/data';
import { IncomeChart } from '@/app/(app)/reports/earnings/_components/IncomeChart';
import { ByTypeBreakdown } from '@/app/(app)/reports/earnings/_components/ByTypeBreakdown';
import { PageShell } from '@/app/page-shell';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { ErrorState } from '@/components/patterns/error-state';
import { StatCard } from '@/components/patterns/stat-card';
import { Money } from '@/app/money';
import { loadHideValues } from '@/app/hide-values';
import { concealSeries } from '@/app/chart-series';
import { Note } from '@/components/patterns/note';
import { Stack } from '@/components/layout/stack';
import { Grid } from '@/components/layout/grid';
import { Text } from '@/components/ui/text';
import { NodeTable, type NodeColumn } from '@/components/patterns/node-table';
import { ranksOf } from '@/lib/rank-keys';
import { tableLabels, type ReportTableLabels } from '@/app/(app)/reports/_components/table-labels';

/**
 * SPEC-014 — **Proventos**.
 *
 * The report Marina's persona exists for: a portfolio built to pay, where the
 * question is not what it is worth but what it produces and whether that is
 * growing. Grouping by wallet answers it directly, and BR-014-12 is what makes
 * that answer stable — income is attributed to the wallet that held the asset
 * when the payment landed, so filing a holding somewhere new today does not
 * rewrite last year.
 *
 * Never statically prerendered: one tenant's own income.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function EarningsPage({ searchParams }: PageProps) {
  const t = await getTranslations('reports');
  const tp = await getTranslations('proventos');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell title={t('title')}>
        <EmptyState title={t('signedOut')} />
      </PageShell>
    );
  }

  // SPEC-022 BR-022-24: the income chart's coordinates are rescaled when masked.
  const masked = await loadHideValues();
  const raw = await searchParams;
  const params = {
    get: (name: string) => {
      const value = raw[name];
      return typeof value === 'string' ? value : null;
    },
  };

  // Parsed twice: the default grouping depends on the resolved scope
  // (BR-011-04), and the scope is itself one of the parsed values.
  const provisional = fromSearchParams(params, 'asset_class');
  const state = fromSearchParams(params, defaultGroupingFor(provisional.scope, undefined));

  const { wallets, query, report } = await loadEarnings(userId, {
    period: state.period,
    scope: state.scope,
    grouping: state.grouping,
  });

  return (
    <ReportsFrame
      wallets={wallets.map((wallet) => ({ walletId: wallet.walletId, name: wallet.name }))}
      description={tp('description')}
    >
      <Controls
        action="/reports/earnings"
        period={state.period}
        scope={state.scope}
        grouping={state.grouping}
      />

      {!query.ok ? (
        <ErrorState
          title={
            query.error.code === 'REPORTING_INVALID_PERIOD_RANGE'
              ? t('period.invalidRange')
              : t('scope.walletNotFound')
          }
        />
      ) : report === null || report.empty ? (
        // BR-011-16 / AC-16: an explanation, never a zero-filled chart.
        <ReportEmptyState scoped={state.scope.kind === 'wallet'} />
      ) : (
        <Stack gap="lg">
          {/*
            BR-014-12 stated where the figures are, not in a help page. At
            wallet scope the attribution is the difference between a number a
            user can rely on and one that moves when they tidy their wallets.
          */}
          {state.scope.kind === 'wallet' && <Note>{tp('walletScope.explanation')}</Note>}

          <Headline report={report} labels={headlineLabels(tp)} />

          {/* SPEC-022 BR-022-36 — each type is a figure card, so the group heading
              sits on the page rather than drawing a panel around panels. */}
          <Section
            variant="plain"
            title={tp('byType.title')}
            description={tp('byType.description')}
          >
            <ByTypeBreakdown
              items={report.byType.map((total) => ({
                type: total.type,
                label: tp(`byType.${total.type}`),
                amount: total.amount,
              }))}
            />
          </Section>

          <Section title={tp('monthly.title')} description={tp('monthly.description')}>
            <Stack gap="md">
              <IncomeChart
                masked={masked}
                title={tp('monthly.chartLabel')}
                // SPEC-016 BR-016-16: the figures are the table beneath.
                summary={tp('monthly.chartText')}
                labels={{ bars: tp('monthly.bars'), average: tp('monthly.average') }}
                points={concealSeries(
                  report.monthly.map((month) => ({
                    month: month.month,
                    amount: Number(month.amount.toString()),
                    average:
                      month.movingAverage === null ? null : Number(month.movingAverage.toString()),
                  })),
                  ['amount', 'average'],
                  masked,
                )}
              />
              <MonthlyTable
                months={report.monthly}
                labels={monthlyLabels(tp)}
                table={tableLabels(t, {
                  caption: tp('monthly.caption'),
                  noun: tp('monthly.noun'),
                })}
              />
            </Stack>
          </Section>

          <Section title={tp('breakdown.title')} description={tp('breakdown.description')}>
            <BreakdownTable
              report={report}
              labels={{
                group: tp('breakdown.columnGroup'),
                amount: tp('breakdown.columnAmount'),
                share: tp('breakdown.columnShare'),
                caption: tp('breakdown.caption'),
                total: t('table.total'),
              }}
              labelOf={(key) => resolveGroupLabel(key, query.value.groupNames, t)}
              table={tableLabels(t, {
                caption: tp('breakdown.caption'),
                noun: tp('breakdown.noun'),
                filterPlaceholder: tp('breakdown.filterPlaceholder'),
              })}
            />
          </Section>

          <Section title={tp('perAsset.title')} description={tp('perAsset.description')}>
            <AssetTable
              rows={report.perAsset}
              labels={assetLabels(tp)}
              table={tableLabels(t, {
                caption: tp('perAsset.caption'),
                noun: tp('perAsset.noun'),
                filterPlaceholder: tp('perAsset.filterPlaceholder'),
              })}
            />
          </Section>

          {/*
            BR-014-09/10 / DL-014-06 — the section exists and says why it is
            empty. Rendering nothing here would read as "you have no upcoming
            income", which is a claim this product has no source for.
          */}
          <Section title={tp('upcoming.title')}>
            <Note>{tp('upcoming.unavailable')}</Note>
          </Section>
        </Stack>
      )}
    </ReportsFrame>
  );
}

type Translate = Awaited<ReturnType<typeof getTranslations>>;

function headlineLabels(tp: Translate) {
  return {
    total: tp('headline.total'),
    totalHint: tp('headline.totalHint'),
    yieldOnCost: tp('headline.yieldOnCost'),
    yieldOnCostHint: tp('headline.yieldOnCostHint'),
    growth: tp('headline.growth'),
    growthHint: tp('headline.growthHint'),
    growthUnavailable: tp('headline.growthUnavailable'),
    unavailable: tp('headline.unavailable'),
  };
}

function monthlyLabels(tp: Translate) {
  return {
    caption: tp('monthly.caption'),
    month: tp('monthly.columnMonth'),
    amount: tp('monthly.columnAmount'),
    average: tp('monthly.columnAverage'),
    none: tp('monthly.noAverage'),
  };
}

function assetLabels(tp: Translate) {
  return {
    caption: tp('perAsset.caption'),
    asset: tp('perAsset.columnAsset'),
    amount: tp('perAsset.columnAmount'),
    yieldOnCost: tp('perAsset.columnYieldOnCost'),
    currentYield: tp('perAsset.columnCurrentYield'),
    unavailable: tp('perAsset.unavailable'),
  };
}

/** BR-014-01/05/07 — the three figures the report is read for. */
function Headline({
  report,
  labels,
}: {
  readonly report: EarningsReport;
  readonly labels: ReturnType<typeof headlineLabels>;
}) {
  return (
    <Grid cols={3} gap="md">
      <StatCard
        label={labels.total}
        value={<Money value={report.total} />}
        hint={labels.totalHint}
      />
      <StatCard
        label={labels.yieldOnCost}
        value={
          report.yieldOnCost === null ? (
            labels.unavailable
          ) : (
            <Money value={report.yieldOnCost} kind="percent" />
          )
        }
        hint={labels.yieldOnCostHint}
      />
      <StatCard
        label={labels.growth}
        value={
          report.growth.change === null ? (
            labels.unavailable
          ) : (
            <Money value={report.growth.change} kind="percent" signed />
          )
        }
        // BR-014-07: growth from nothing is not a percentage, and saying so is
        // more useful than an em dash the reader has to interpret.
        hint={report.growth.change === null ? labels.growthUnavailable : labels.growthHint}
      />
    </Grid>
  );
}

/**
 * DS-31 / SPEC-016 BR-016-15 — the monthly chart's required text equivalent: an
 * SVG of bars carries its whole message in a form a screen reader cannot read,
 * so the same figures are here as a table, next to the chart.
 *
 * SPEC-022 BR-022-18: it grows by a row a month, so it pages and sorts, newest
 * month first. It used to sit visually hidden inside the chart's description;
 * a paginated table with controls cannot be hidden (its buttons would be tab
 * stops nobody can see), so it is on the page and the chart's own description
 * is a sentence that points to it, the way Evolução patrimonial's is.
 */
function MonthlyTable({
  months,
  labels,
  table,
}: {
  readonly months: readonly MonthlyIncome[];
  readonly labels: ReturnType<typeof monthlyLabels>;
  readonly table: ReportTableLabels;
}) {
  const columns: NodeColumn[] = [
    { id: 'month', header: labels.month, kind: 'date', sortable: true },
    { id: 'amount', header: labels.amount, kind: 'money', sortable: true },
    // The header is the longest thing in this column ("Média móvel (12 meses)").
    { id: 'average', header: labels.average, kind: 'money', width: 25, sortable: true },
  ];
  const amountRanks = ranksOf(months, (month) => month.amount);
  const averageRanks = ranksOf(months, (month) => month.movingAverage);

  return (
    <NodeTable
      columns={columns}
      {...table}
      paramPrefix="monthly"
      sort={{ id: 'month', desc: true }}
      rows={months.map((month, index) => ({
        cells: {
          month: month.month,
          amount: <Money value={month.amount} />,
          average:
            month.movingAverage === null ? labels.none : <Money value={month.movingAverage} />,
        },
        // No average for the first eleven months: absent, not the smallest.
        keys: { month: month.month, amount: amountRanks[index], average: averageRanks[index] },
      }))}
    />
  );
}

/**
 * BR-014-04 — ranked groups with their share of the period's income.
 *
 * SPEC-022 BR-022-18: the groups are the grouping the reader chose, and by
 * asset or by sector they grow with the portfolio, so the table pages and
 * filters like any other. The total closes it on every page.
 */
function BreakdownTable({
  report,
  labels,
  labelOf,
  table,
}: {
  readonly report: EarningsReport;
  readonly labels: {
    readonly group: string;
    readonly amount: string;
    readonly share: string;
    readonly caption: string;
    readonly total: string;
  };
  readonly labelOf: (key: GroupKey) => string;
  readonly table: ReportTableLabels;
}) {
  const columns: NodeColumn[] = [
    { id: 'group', header: labels.group, kind: 'text', sortable: true },
    { id: 'amount', header: labels.amount, kind: 'money', sortable: true },
    { id: 'share', header: labels.share, kind: 'percent', width: 15, sortable: true },
  ];
  const amountRanks = ranksOf(report.breakdown, (slice) => slice.amount);
  const shareRanks = ranksOf(report.breakdown, (slice) => slice.share);

  return (
    <NodeTable
      columns={columns}
      {...table}
      paramPrefix="breakdown"
      sort={{ id: 'amount', desc: true }}
      totals={{ label: labels.total, cells: { amount: <Money value={report.total} /> } }}
      rows={report.breakdown.map((slice, index) => {
        const group = labelOf(slice.key);
        return {
          cells: {
            group: <span className="font-medium">{group}</span>,
            amount: <Money value={slice.amount} />,
            share: slice.share === null ? '' : <Money value={slice.share} kind="percent" />,
          },
          keys: { group, amount: amountRanks[index], share: shareRanks[index] },
        };
      })}
    />
  );
}

/**
 * BR-014-05/06 — both yields, side by side and labelled, which is the whole
 * point: they describe different people, and either one alone would be read as
 * "the yield".
 *
 * SPEC-022 BR-022-18: one row per asset that paid in the period, so it pages,
 * sorts and filters by ticker.
 */
function AssetTable({
  rows,
  labels,
  table,
}: {
  readonly rows: readonly AssetIncome[];
  readonly labels: ReturnType<typeof assetLabels>;
  readonly table: ReportTableLabels;
}) {
  const columns: NodeColumn[] = [
    { id: 'asset', header: labels.asset, kind: 'text', sortable: true },
    { id: 'amount', header: labels.amount, kind: 'money', sortable: true },
    // Sized for their headers, the longest thing in them.
    { id: 'yieldOnCost', header: labels.yieldOnCost, kind: 'percent', width: 16, sortable: true },
    { id: 'currentYield', header: labels.currentYield, kind: 'percent', width: 23, sortable: true },
  ];
  const amountRanks = ranksOf(rows, (row) => row.amount);
  const yieldOnCostRanks = ranksOf(rows, (row) => row.yieldOnCost);
  const currentYieldRanks = ranksOf(rows, (row) => row.currentYield);

  return (
    <NodeTable
      columns={columns}
      {...table}
      paramPrefix="asset"
      sort={{ id: 'amount', desc: true }}
      rows={rows.map((row, index) => ({
        cells: {
          asset: <span className="font-medium">{row.assetCode}</span>,
          amount: <Money value={row.amount} />,
          yieldOnCost: <Yield value={row.yieldOnCost} fallback={labels.unavailable} />,
          currentYield: <Yield value={row.currentYield} fallback={labels.unavailable} />,
        },
        // A yield the report declined to compute has no rank: it sorts last in
        // both directions rather than passing for 0 %.
        keys: {
          asset: row.assetCode,
          amount: amountRanks[index],
          yieldOnCost: yieldOnCostRanks[index],
          currentYield: currentYieldRanks[index],
        },
      }))}
    />
  );
}

/**
 * A yield the report declined to compute renders as a dash, not as 0 %. The
 * asset was sold, or is held at no recorded cost — "we cannot compute this"
 * and "this yields nothing" are different statements and only one is true.
 */
function Yield({
  value,
  fallback,
}: {
  readonly value: MoneyValue | null;
  readonly fallback: string;
}) {
  if (value === null)
    return (
      <Text as="span" tone="muted">
        {fallback}
      </Text>
    );
  return <Money value={value} kind="percent" />;
}
