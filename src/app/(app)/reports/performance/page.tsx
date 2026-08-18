import { getTranslations } from 'next-intl/server';
import { defaultGroupingFor } from '@/core/reporting/grouping';
import { GroupLabel } from '@/app/(app)/reports/_components/GroupLabel';
import {
  EarningsTreatment,
  type Benchmark,
  type GroupPerformance,
  type PerformanceResult,
  type Rate,
  type TwrResult,
  type XirrResult,
} from '@/core/reporting/performance/ports';
import { fromSearchParams } from '@/lib/report-url-state';
import { Controls } from '@/app/(app)/reports/_components/Controls';
import { ReportEmptyState } from '@/app/(app)/reports/_components/ReportEmptyState';
import { ReportNav } from '@/app/(app)/reports/_components/ReportNav';
import { tryUserId } from '@/app/(app)/reports/session';
import { comparisonSeries } from '@/core/reporting/performance/comparison-series';
import { loadPerformance } from '@/app/(app)/reports/performance/data';
import { BenchmarkChart } from '@/app/(app)/reports/performance/_components/BenchmarkChart';
import { PageShell } from '@/components/patterns/page-shell';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { ErrorState } from '@/components/patterns/error-state';
import { StatCard } from '@/components/patterns/stat-card';
import { Money } from '@/components/patterns/money';
import { Note } from '@/components/patterns/note';
import { Stack } from '@/components/layout/stack';
import { Grid } from '@/components/layout/grid';
import { Cluster } from '@/components/layout/cluster';
import { Badge } from '@/components/ui/badge';
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
 * SPEC-012 — **Rentabilidade**.
 *
 * **Two returns are shown, always, and the page's job is to stop that reading
 * as a bug.** DL-012-01: TWR and XIRR answer different questions and
 * legitimately differ — TWR neutralises the timing of deposits, XIRR is what
 * the user's own money actually earned. Showing one silently answers a
 * question nobody asked; showing both without comment looks like arithmetic
 * that failed. So when they diverge materially the page says why, inline
 * (BR-012-04) — DL-012-02 calls that explanation "the feature", not a caveat.
 *
 * **Every measure that could not be computed says so by name.** A
 * non-convergent XIRR renders as *indisponível*, never as 0 % (BR-012-05 / the
 * spec's own acceptance criterion). Zero is a claim about the portfolio; this
 * is a fact about the calculation, and conflating them is how a user comes to
 * believe they earned nothing.
 *
 * SPEC-016 BR-016-16: every figure below is text in a table. There is no chart
 * on this page whose numbers are not also written down, which is why the
 * screen is legible to a screen reader and to anyone printing it.
 *
 * Never statically prerendered — one tenant's own returns.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** `Rate` is a fraction; `Money kind="percent"` formats a fraction. No scaling. */
function RateCell({ rate }: { readonly rate: Rate | null }) {
  if (rate === null) return <>—</>;
  return <Money value={rate} kind="percent" signed />;
}

export default async function PerformancePage({ searchParams }: PageProps) {
  const t = await getTranslations('reports');
  const tr = await getTranslations('rentabilidade');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell width="wide" title={tr('title')}>
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

  const provisional = fromSearchParams(params, 'asset_class');
  const state = fromSearchParams(params, defaultGroupingFor(provisional.scope, undefined));

  // BR-012-09: both views exist for every scope, period and grouping. The URL
  // carries it like every other control, so a bookmark reproduces the view.
  const treatment: EarningsTreatment =
    params.get('earnings') === 'without'
      ? EarningsTreatment.WITHOUT_EARNINGS
      : EarningsTreatment.WITH_EARNINGS;

  const { wallets, report } = await loadPerformance(userId, { ...state, treatment });

  return (
    <PageShell width="wide" title={tr('title')} description={tr('description')}>
      <ReportNav current="/reports/performance" />

      <Controls
        action="/reports/performance"
        period={state.period}
        scope={state.scope}
        grouping={state.grouping}
        wallets={wallets.map((wallet) => ({ walletId: wallet.walletId, name: wallet.name }))}
      />

      {!report.ok ? (
        <ErrorState
          title={
            report.error.code === 'REPORTING_INVALID_PERIOD_RANGE'
              ? t('period.invalidRange')
              : t('scope.walletNotFound')
          }
        />
      ) : report.value.empty ? (
        // BR-012-18 / AC: a period with no holdings gets an empty state, never
        // a zero return and never an infinite one.
        <ReportEmptyState scoped={state.scope.kind === 'wallet'} />
      ) : (
        <Stack gap="xl">
          <Grid cols={4}>
            <StatCard
              label={tr('headline.twr')}
              value={<HeadlineRate result={report.value.twr} pick={(v) => v.returnRate} />}
              hint={tr('headline.twrHint')}
            />
            <StatCard
              label={tr('headline.xirr')}
              value={<HeadlineRate result={report.value.xirr} pick={(v) => v.rate} />}
              hint={tr('headline.xirrHint')}
            />
            <StatCard
              label={tr('headline.percentOfCdi')}
              value={
                report.value.percentOfCdi.ok ? (
                  <Money value={report.value.percentOfCdi.value} kind="percentPoints" />
                ) : (
                  <Text as="span" size="lg">
                    {tr('unavailable')}
                  </Text>
                )
              }
              hint={tr('headline.percentOfCdiHint')}
            />
            <StatCard
              label={tr('headline.realReturn')}
              value={<HeadlineRate result={report.value.realReturn} pick={(v) => v} />}
              hint={tr('headline.realReturnHint')}
            />
          </Grid>

          {/* SPEC-011 BR-011-02 / SPEC-012 AC-16 — **why four of the figures
              above say *indisponível*.**

              `daily_valuation_snapshots` is portfolio grain (ADR-002), so a
              wallet has no daily value series and no daily flow series behind
              it. TWR, XIRR, "% do CDI" and the real return therefore have no
              wallet-scoped answer, and neither does BR-012-12's shadow
              portfolio — it is defined as *the user's own contributions at the
              index's rate*, and the only contributions on hand are the whole
              portfolio's. Rendered before the benchmark table rather than after
              it, because the reader meets the blanks first.

              Keyed off the **resolved** scope rather than the parsed URL, for
              the reason `scope.ts` gives for carrying it: the note must
              describe the scope the figures were actually computed at, not one
              held in client state beside them. */}
          {report.value.scope.scope.kind === 'wallet' && (
            <Note>{tr('walletScope.explanation')}</Note>
          )}

          {/* BR-012-04 / DL-012-02 — the explanation is the feature. */}
          {report.value.explainDivergence && <Note>{tr('divergence.explanation')}</Note>}

          {/* BR-012-02 / DL-012-06 — disclosed, never a silent substitution. */}
          {report.value.twr.ok && report.value.twr.value.dietzPeriods.length > 0 && (
            <Note>
              {tr('dietz.disclosure', { count: report.value.twr.value.dietzPeriods.length })}
            </Note>
          )}

          {/* BR-012-06/07 — the two views, as links so the state stays in the URL. */}
          <Cluster gap="sm">
            <Badge
              variant={treatment === EarningsTreatment.WITH_EARNINGS ? 'secondary' : 'outline'}
            >
              {tr(
                treatment === EarningsTreatment.WITH_EARNINGS
                  ? 'treatment.withEarnings'
                  : 'treatment.withoutEarnings',
              )}
            </Badge>
            <Text tone="muted" size="xs">
              {tr('treatment.hint')}
            </Text>
          </Cluster>

          {/* BR-012-12 / DL-012-04 — the comparison, drawn. Everything on it
              is also in the table below, which is what BR-016-16 asks for:
              the chart carries the shape, the table carries the figures. */}
          {report.value.twr.ok && (
            <Section title={tr('chart.title')} description={tr('chart.description')}>
              <BenchmarkChart
                title={tr('chart.title')}
                summary={tr('chart.summary')}
                series={['portfolio', ...report.value.benchmarks.map((b) => b.benchmark)]}
                points={comparisonSeries(
                  report.value.twr.value.subPeriods,
                  report.value.benchmarks.flatMap((outcome) =>
                    outcome.line.ok ? [outcome.line.value] : [],
                  ),
                ).map((row) => ({
                  date: row.date,
                  // Plotting coordinates only — see the chart's own header.
                  portfolio: Number(row.portfolio.toString()),
                  ...Object.fromEntries(
                    [...row.benchmarks].map(([key, value]) => [key, Number(value.toString())]),
                  ),
                }))}
              />
            </Section>
          )}

          {/* BR-012-10..12 — each benchmark, its own return, and what the
              user's own contributions would have been worth at that rate. */}
          <Section title={tr('benchmarks.title')} description={tr('benchmarks.description')}>
            <Table>
              <TableCaption className="sr-only">{tr('benchmarks.title')}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{tr('benchmarks.columnName')}</TableHead>
                  <TableHead scope="col" className="text-right">
                    {tr('benchmarks.columnIndexReturn')}
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    {tr('benchmarks.columnShadow')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.value.benchmarks.map((outcome) => (
                  <TableRow key={outcome.benchmark}>
                    <TableCell className="py-row font-medium">
                      {benchmarkLabel(outcome.benchmark)}
                    </TableCell>
                    <TableCell className="py-row text-right">
                      {outcome.line.ok ? (
                        <Money value={outcome.line.value.returnRate} kind="percent" signed />
                      ) : (
                        tr('unavailable')
                      )}
                    </TableCell>
                    <TableCell className="py-row text-right">
                      {outcome.shadow ? (
                        <Money value={outcome.shadow.finalValue} />
                      ) : (
                        tr('unavailable')
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>

          {/* BR-012-15/16 — and the footer is the assertion: contributions sum
              to the total return. A reader can check it by eye. */}
          <Section title={tr('contribution.title')} description={tr('contribution.description')}>
            {!report.value.contribution.ok ? (
              <Text tone="muted">{tr('contribution.unavailable')}</Text>
            ) : (
              <Table>
                <TableCaption className="sr-only">{tr('contribution.title')}</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">{t('table.group')}</TableHead>
                    <TableHead scope="col" className="text-right">
                      {tr('contribution.columnWeight')}
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      {tr('contribution.columnOwnReturn')}
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      {tr('contribution.columnContribution')}
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      {tr('contribution.columnGain')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.value.contribution.value.groups.map((group: GroupPerformance) => (
                    <TableRow key={group.key.id}>
                      <TableCell className="py-row font-medium">
                        <GroupLabel groupKey={group.key} names={report.value.groupNames} />
                      </TableCell>
                      <TableCell className="py-row text-right">
                        <Money value={group.weight} kind="percent" />
                      </TableCell>
                      <TableCell className="py-row text-right">
                        <RateCell rate={group.ownReturn} />
                      </TableCell>
                      <TableCell className="py-row text-right">
                        <Money value={group.contribution} kind="percent" signed />
                      </TableCell>
                      <TableCell className="py-row text-right">
                        <Money value={group.gain} signed />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableHead scope="row" className="py-row text-left">
                      {t('table.total')}
                    </TableHead>
                    <TableCell className="py-row" />
                    <TableCell className="py-row" />
                    <TableCell className="py-row text-right">
                      <Money
                        value={report.value.contribution.value.totalReturn}
                        kind="percent"
                        signed
                      />
                    </TableCell>
                    <TableCell className="py-row text-right">
                      <Money value={report.value.contribution.value.totalGain} signed />
                    </TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            )}
          </Section>
        </Stack>
      )}
    </PageShell>
  );
}

/**
 * A measure that could not be computed renders as *indisponível*, never as a
 * number. BR-012-05's acceptance criterion is explicit that a non-convergent
 * XIRR must not read as zero, and the same reasoning covers every other
 * `PerformanceResult` on this page.
 */
async function HeadlineRate<T>({
  result,
  pick,
}: {
  readonly result: PerformanceResult<T>;
  readonly pick: (value: T) => Rate;
}) {
  const tr = await getTranslations('rentabilidade');
  if (!result.ok) {
    return (
      <Text as="span" size="lg">
        {tr('unavailable')}
      </Text>
    );
  }
  return <Money value={pick(result.value)} kind="percent" signed />;
}

/** The three benchmark names are proper nouns, not translatable copy. */
function benchmarkLabel(benchmark: Benchmark): string {
  return benchmark;
}

export type { TwrResult, XirrResult };
