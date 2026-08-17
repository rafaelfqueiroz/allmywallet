import { getTranslations } from 'next-intl/server';
import { defaultGroupingFor } from '@/core/reporting/grouping';
import type { Money as MoneyValue } from '@/core/shared/money';
import type {
  GrowthDecomposition,
  MonthlyContribution,
  ValuePoint,
} from '@/core/reporting/portfolio-value/ports';
import { fromSearchParams } from '@/lib/report-url-state';
import { hasFixedIncome } from '@/lib/fixed-income';
import { Controls } from '@/app/(app)/reports/_components/Controls';
import { ReportEmptyState } from '@/app/(app)/reports/_components/ReportEmptyState';
import { ReportNav } from '@/app/(app)/reports/_components/ReportNav';
import { tryUserId } from '@/app/(app)/reports/session';
import { loadPatrimonio } from '@/app/(app)/reports/patrimonio/data';
import { ValueChart } from '@/app/(app)/reports/patrimonio/_components/ValueChart';
import { ContributionChart } from '@/app/(app)/reports/patrimonio/_components/ContributionChart';
import { PageShell } from '@/components/patterns/page-shell';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { ErrorState } from '@/components/patterns/error-state';
import { StatCard } from '@/components/patterns/stat-card';
import { Money } from '@/components/patterns/money';
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
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * SPEC-013 — **Patrimônio**.
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

/**
 * The server/client boundary for chart geometry. `Money` never crosses it —
 * see `ValueChart.tsx`'s header. Every figure a user *reads* on this page is
 * rendered from `Money` on the server, in the summaries and the table.
 */
const plot = (value: MoneyValue): number => Number(value.toString());

export default async function PatrimonioPage({ searchParams }: PageProps) {
  const t = await getTranslations('reports');
  const tp = await getTranslations('patrimonio');
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

  // Parsed twice for the same reason `/reports` does it: the default grouping
  // depends on the scope (BR-011-04), and the scope is one of the parsed
  // values.
  const provisional = fromSearchParams(params, 'asset_class');
  const state = fromSearchParams(params, defaultGroupingFor(provisional.scope, undefined));

  const { wallets, query, report } = await loadPatrimonio(userId, state);

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
    <PageShell width="wide" title={tp('title')} description={tp('description')}>
      <ReportNav current="/reports/patrimonio" />

      <Controls
        action="/reports/patrimonio"
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
                    title={tp('chart.title')}
                    summary={<SeriesSummary points={history.series} label={tp('chart.summary')} />}
                    points={history.series.map((point) => ({
                      date: point.date,
                      value: plot(point.value),
                      estimated: point.estimated,
                    }))}
                  />
                  {history.series.some((point) => point.estimated) && (
                    // BR-013-07 / DL-013-04: the marker sits with the chart, not in
                    // a footnote read once and forgotten.
                    <Badge variant="outline">{tp('estimated.badge')}</Badge>
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
                  title={tp('contributions.title')}
                  summary={
                    <ContributionSummary
                      bars={history.contributions}
                      label={tp('contributions.summary')}
                    />
                  }
                  bars={history.contributions.map((bar) => ({
                    month: bar.month,
                    amount: plot(bar.amount),
                  }))}
                />
              </Section>

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

              {/* SPEC-016 BR-016-16 — the chart, as a table. Not a fallback: the
                  exact figures are here and only the shape is in the chart. */}
              <Section title={tp('table.title')}>
                <SeriesTable
                  points={history.series}
                  labels={{
                    caption: tp('table.title'),
                    date: tp('table.date'),
                    value: tp('table.value'),
                    basis: tp('table.basis'),
                    observed: tp('table.observed'),
                    estimated: tp('table.estimated'),
                  }}
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
    </PageShell>
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
    <Table>
      <TableCaption className="sr-only">{labels.caption}</TableCaption>
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
            <TableCell className="text-right">
              <Money value={row.value} signed={row.signed} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SeriesTable({
  points,
  labels,
}: {
  points: readonly ValuePoint[];
  labels: Record<'caption' | 'date' | 'value' | 'basis' | 'observed' | 'estimated', string>;
}) {
  return (
    <Table>
      <TableCaption className="sr-only">{labels.caption}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{labels.date}</TableHead>
          <TableHead scope="col" className="text-right">
            {labels.value}
          </TableHead>
          <TableHead scope="col">{labels.basis}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {points.map((point) => (
          <TableRow key={point.date}>
            <TableHead scope="row" className="text-left font-normal">
              {point.date}
            </TableHead>
            <TableCell className="text-right">
              <Money value={point.value} />
            </TableCell>
            <TableCell>{point.estimated ? labels.estimated : labels.observed}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
