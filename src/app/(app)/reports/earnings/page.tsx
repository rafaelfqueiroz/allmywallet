import { getTranslations } from 'next-intl/server';
import { defaultGroupingFor } from '@/core/reporting/grouping';
import type { GroupKey } from '@/core/reporting/ports';
import type { Money as MoneyValue } from '@/core/shared/money';
import type { AssetIncome, EarningsReport, MonthlyIncome } from '@/core/reporting/earnings/ports';
import { fromSearchParams } from '@/lib/report-url-state';
import { Controls } from '@/app/(app)/reports/_components/Controls';
import { ReportEmptyState } from '@/app/(app)/reports/_components/ReportEmptyState';
import { ReportNav } from '@/app/(app)/reports/_components/ReportNav';
import { resolveGroupLabel } from '@/app/(app)/reports/_components/GroupLabel';
import { tryUserId } from '@/app/(app)/reports/session';
import { loadEarnings } from '@/app/(app)/reports/earnings/data';
import { IncomeChart } from '@/app/(app)/reports/earnings/_components/IncomeChart';
import { PageShell } from '@/components/patterns/page-shell';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { ErrorState } from '@/components/patterns/error-state';
import { StatCard } from '@/components/patterns/stat-card';
import { Money } from '@/components/patterns/money';
import { Note } from '@/components/patterns/note';
import { Stack } from '@/components/layout/stack';
import { Grid } from '@/components/layout/grid';
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
      <PageShell width="wide" title={tp('title')}>
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
    <PageShell width="wide" title={tp('title')} description={tp('description')}>
      <ReportNav current="/reports/earnings" />

      <Controls
        action="/reports/earnings"
        period={state.period}
        scope={state.scope}
        grouping={state.grouping}
        wallets={wallets.map((wallet) => ({ walletId: wallet.walletId, name: wallet.name }))}
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

          <Section title={tp('byType.title')} description={tp('byType.description')}>
            <Grid cols={4} gap="md">
              {report.byType.map((total) => (
                <StatCard
                  key={total.type}
                  label={tp(`byType.${total.type}`)}
                  value={<Money value={total.amount} />}
                />
              ))}
            </Grid>
          </Section>

          <Section title={tp('monthly.title')} description={tp('monthly.description')}>
            <Stack gap="md">
              <IncomeChart
                title={tp('monthly.chartLabel')}
                summary={<MonthlyTable months={report.monthly} labels={monthlyLabels(tp)} />}
                labels={{ bars: tp('monthly.bars'), average: tp('monthly.average') }}
                points={report.monthly.map((month) => ({
                  month: month.month,
                  amount: Number(month.amount.toString()),
                  average:
                    month.movingAverage === null ? null : Number(month.movingAverage.toString()),
                }))}
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
            />
          </Section>

          <Section title={tp('perAsset.title')} description={tp('perAsset.description')}>
            <AssetTable rows={report.perAsset} labels={assetLabels(tp)} />
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
    </PageShell>
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
 * DS-31 / SPEC-016 BR-016-15 — the chart's required text equivalent. An SVG of
 * bars carries its whole message in a form a screen reader cannot read, so the
 * same figures are here as a table.
 */
function MonthlyTable({
  months,
  labels,
}: {
  readonly months: readonly MonthlyIncome[];
  readonly labels: ReturnType<typeof monthlyLabels>;
}) {
  return (
    <Table>
      <TableCaption className="sr-only">{labels.caption}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{labels.month}</TableHead>
          <TableHead scope="col" className="text-right">
            {labels.amount}
          </TableHead>
          <TableHead scope="col" className="text-right">
            {labels.average}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {months.map((month) => (
          <TableRow key={month.month}>
            <TableCell className="py-row">{month.month}</TableCell>
            <TableCell className="py-row text-right">
              <Money value={month.amount} />
            </TableCell>
            <TableCell className="py-row text-right">
              {month.movingAverage === null ? labels.none : <Money value={month.movingAverage} />}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** BR-014-04 — ranked groups with their share of the period's income. */
function BreakdownTable({
  report,
  labels,
  labelOf,
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
}) {
  return (
    <Table>
      <TableCaption className="sr-only">{labels.caption}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{labels.group}</TableHead>
          <TableHead scope="col" className="text-right">
            {labels.amount}
          </TableHead>
          <TableHead scope="col" className="text-right">
            {labels.share}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {report.breakdown.map((slice) => (
          <TableRow key={slice.key.id}>
            <TableCell className="py-row font-medium">{labelOf(slice.key)}</TableCell>
            <TableCell className="py-row text-right">
              <Money value={slice.amount} />
            </TableCell>
            <TableCell className="py-row text-right">
              {slice.share === null ? '' : <Money value={slice.share} kind="percent" />}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableHead scope="row" className="py-row text-left">
            {labels.total}
          </TableHead>
          <TableCell className="py-row text-right">
            <Money value={report.total} />
          </TableCell>
          <TableCell className="py-row" />
        </TableRow>
      </TableFooter>
    </Table>
  );
}

/**
 * BR-014-05/06 — both yields, side by side and labelled, which is the whole
 * point: they describe different people, and either one alone would be read as
 * "the yield".
 */
function AssetTable({
  rows,
  labels,
}: {
  readonly rows: readonly AssetIncome[];
  readonly labels: ReturnType<typeof assetLabels>;
}) {
  return (
    <Table>
      <TableCaption className="sr-only">{labels.caption}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{labels.asset}</TableHead>
          <TableHead scope="col" className="text-right">
            {labels.amount}
          </TableHead>
          <TableHead scope="col" className="text-right">
            {labels.yieldOnCost}
          </TableHead>
          <TableHead scope="col" className="text-right">
            {labels.currentYield}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.assetId}>
            <TableCell className="py-row font-medium">{row.assetCode}</TableCell>
            <TableCell className="py-row text-right">
              <Money value={row.amount} />
            </TableCell>
            <TableCell className="py-row text-right">
              <Yield value={row.yieldOnCost} fallback={labels.unavailable} />
            </TableCell>
            <TableCell className="py-row text-right">
              <Yield value={row.currentYield} fallback={labels.unavailable} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
