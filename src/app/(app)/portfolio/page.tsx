import { getTranslations } from 'next-intl/server';
import { SystemClock } from '@/core/shared/clock';
import type { Money as MoneyValue } from '@/core/shared/money';
import type { AssetClass } from '@/core/quotes/ports';
import type { ReportHolding } from '@/core/reporting/ports';
import type { CompositionReport, CompositionSlice } from '@/core/reporting/composition/ports';
import { unrealizedResult } from '@/core/reporting/composition/result';
import { assetClassColor } from '@/components/charts/palette';
import { ShareBar } from '@/components/charts/share-bar';
import { fromSearchParams } from '@/lib/report-url-state';
import { hasFixedIncome } from '@/lib/fixed-income';
import { tryUserId } from '@/lib/session';
import { loadCurrentComposition } from '@/app/(app)/portfolio/data';
import { PortfolioFrame } from '@/app/(app)/portfolio/_components/PortfolioFrame';
import { holdingRows, holdingsTableLabels } from '@/app/(app)/portfolio/_components/holding-rows';
import { EstimatedValue } from '@/app/(app)/portfolio/_components/EstimatedValue';
import { HoldingsTable } from '@/app/(app)/portfolio/composition/_components/HoldingsTable';
import { ReportEmptyState } from '@/app/(app)/reports/_components/ReportEmptyState';
import { HoldingMarkers } from '@/app/(app)/reports/_components/HoldingMarkers';
import { PageShell } from '@/app/page-shell';
import { Money } from '@/app/money';
import { loadHideValues } from '@/app/hide-values';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { ErrorState } from '@/components/patterns/error-state';
import { EstimateMarker } from '@/components/patterns/estimate-marker';
import { StatCard } from '@/components/patterns/stat-card';
import { Note } from '@/components/patterns/note';
import { NodeTable, type NodeRow } from '@/components/patterns/node-table';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Grid } from '@/components/layout/grid';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Text } from '@/components/ui/text';

/**
 * SPEC-022 BR-022-02 — **Portfólio › Patrimônio**: the current total, broken
 * down by class and by asset, valued at the latest quote (the approved
 * prototype's page, DL-022-13).
 *
 * It replaces Relatórios' "Visão geral" grouped table as the place to read
 * "what do I have now", and drops that table's quantity column: a quantity
 * summed across different assets counts nothing (BR-022-34). Each class card
 * says how many *assets* it holds instead, and the only quantities on the page
 * are per asset, in the table.
 *
 * **Every figure is the Composição report's** (`loadCurrentComposition`,
 * grouped by asset class), so this tab, Composição and the dashboard headline
 * read one holding set and cannot disagree about the total (SPEC-011
 * BR-011-08, SPEC-015 BR-015-10). The one derived figure, the unrealised
 * result, is BR-015-08's subtraction at the grain of a total
 * (`core/reporting/composition/result.ts`).
 *
 * Never statically prerendered: one tenant's own holdings, so a cached copy
 * built once would be served to everyone.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PatrimonioPage({ searchParams }: PageProps) {
  const tp = await getTranslations('portfolio');
  const t = await getTranslations('reports');
  const tc = await getTranslations('composicao');
  const tw = await getTranslations('watch');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell title={tp('title')}>
        <EmptyState title={tp('signedOut')} />
      </PageShell>
    );
  }

  const masked = await loadHideValues();
  const raw = await searchParams;
  const { scope } = fromSearchParams(
    {
      get: (name: string) => {
        const value = raw[name];
        return typeof value === 'string' ? value : null;
      },
    },
    'asset_class',
  );

  // Always by asset class: the cards are classes (BR-022-02). The table below
  // is per asset whatever the grouping, by SPEC-015's construction.
  const { wallets, query, report, lastImportAt } = await loadCurrentComposition(userId, {
    scope,
    grouping: 'asset_class',
  });

  return (
    <PortfolioFrame
      wallets={wallets}
      freshness={
        report === null
          ? undefined
          : {
              valuationAsOf: report.quotes.valuationAsOf,
              quotedAt: report.quotes.quotedAt,
              delayMinutes: report.quotes.delayMinutes,
              lastImportAt,
            }
      }
      actions={
        report !== null && !report.total.value.isZero() ? (
          <ExportLink walletId={scope.kind === 'wallet' ? scope.walletId : null} />
        ) : undefined
      }
    >
      {!query.ok ? (
        // BR-011-16 — the period is built from the clock, so a wallet deleted
        // since the link was made is the only reachable failure.
        <ErrorState title={t('scope.walletNotFound')} />
      ) : query.value.empty || report === null ? (
        <ReportEmptyState scoped={scope.kind === 'wallet'} />
      ) : (
        <Stack gap="lg">
          <Headline report={report} />

          {/* SPEC-022 BR-022-36 — each class card is a panel, so the group
              heading sits on the page rather than drawing a panel around
              panels. */}
          <Section variant="plain" title={tp('patrimonio.byClass')}>
            <Grid cols={4} gap="md">
              {report.breakdown.map((slice) => (
                <ClassCard key={slice.key.id} slice={slice} report={report} />
              ))}
            </Grid>
          </Section>

          <Section title={tp('patrimonio.byAsset')}>
            {/* SPEC-009 BR-009-12 / AC-10: fixed income is gross — nothing in
                this product deducts tax, and the figures must say so where
                they are read: in the panel that lists them (BR-022-36), above
                the table, which closes it with the pager. */}
            {hasFixedIncome(report.rows.map((row) => row.assetClass)) && (
              <Note>{t('grossOfTax')}</Note>
            )}
            <HoldingsTable
              rows={holdingRows(report.rows, new Map(), t, tc, tw, masked)}
              labels={holdingsTableLabels(report, t, tc)}
              hidden={['sector', 'opportunityState']}
            />
          </Section>

          <Unpriced holdings={query.value.report.groups.flatMap((group) => group.holdings)} />
        </Stack>
      )}
    </PortfolioFrame>
  );
}

/**
 * The four headline figures. Each carries its own marker beside it (BR-022-32):
 * SPEC-009's valuation estimate on the value, SPEC-007's cost estimate on the
 * cost — the same two facts the table marks per asset, folded into the total
 * (BR-011-15, DL-007-12).
 */
async function Headline({ report }: { readonly report: CompositionReport }) {
  const tp = await getTranslations('portfolio');
  const t = await getTranslations('reports');

  const { result, ratio } = unrealizedResult(report.total);
  const classes = report.breakdown.length;

  return (
    <Grid cols={4} gap="md">
      <StatCard
        label={tp('patrimonio.value')}
        value={<EstimatedValue value={report.total.value} estimated={report.total.estimated} />}
      />
      <StatCard
        label={tp('patrimonio.cost')}
        value={
          <Cluster gap="sm" align="baseline">
            <Money value={report.total.costBasis} />
            {report.total.costEstimated && (
              <EstimateMarker kind="cost" explanation={t('markers.costEstimated.explanation')} />
            )}
          </Cluster>
        }
        hint={tp('patrimonio.costHint')}
        info={{ id: 'applied-value-info', text: tp('patrimonio.costExplanation') }}
      />
      <StatCard
        label={tp('patrimonio.result')}
        value={<Money value={result} signed />}
        hint={
          ratio === null ? (
            tp('patrimonio.resultNoRatio')
          ) : (
            <Cluster gap="xs" align="baseline">
              <Money value={ratio} kind="percent" signed />
              <span>{tp('patrimonio.resultOnCost')}</span>
            </Cluster>
          )
        }
      />
      <StatCard
        label={tp('patrimonio.assets')}
        value={<span className="tabular-nums">{report.rows.length}</span>}
        hint={tp('patrimonio.assetsInClasses', { classes })}
      />
    </Grid>
  );
}

/**
 * One asset class: its value, its share of the scope as text and as a bar,
 * and how many assets it holds — never a quantity total (BR-022-34).
 *
 * The bar is decoration for the percentage printed above it, so it is hidden
 * from assistive technology rather than given a second accessible name for the
 * same figure. Its width is the share itself: a proportion, not an amount, so
 * it stays when values are masked (BR-022-24).
 */
async function ClassCard({
  slice,
  report,
}: {
  readonly slice: CompositionSlice;
  readonly report: CompositionReport;
}) {
  const tp = await getTranslations('portfolio');
  const t = await getTranslations('reports');
  const assetClass = slice.key.id as AssetClass;
  const color = assetClassColor(assetClass);
  const assets = report.rows.filter((row) => row.assetClass === assetClass).length;

  return (
    <Card data-slot="class-card">
      <CardContent>
        <Stack gap="sm">
          <Cluster justify="between" gap="sm" align="baseline">
            <Cluster gap="sm" align="baseline">
              <span
                aria-hidden="true"
                className="inline-block size-2.5 rounded-sm"
                style={{ backgroundColor: color }}
              />
              <Text as="span" weight="medium">
                {t(`assetClass.${assetClass}`)}
              </Text>
            </Cluster>
            {slice.share !== null && (
              <Text as="span" size="sm" tone="muted">
                <Money value={slice.share} kind="percent" />
              </Text>
            )}
          </Cluster>
          <Text as="span" size="lg" weight="semibold">
            <EstimatedValue value={slice.totals.value} estimated={slice.totals.estimated} />
          </Text>
          <ShareBar percent={barPercent(slice.share)} color={color} />
          <Text as="span" size="xs" tone="muted">
            {tp('patrimonio.classAssets', { count: assets })}
          </Text>
        </Stack>
      </CardContent>
    </Card>
  );
}

/**
 * A share as the bar's percentage. `Money.times` keeps the arithmetic exact,
 * and the string is the decimal's own, so no float stands between the figure
 * and the bar (AR-06). A share that does not exist draws no bar.
 */
function barPercent(share: MoneyValue | null): string {
  return share === null ? '0' : share.times('100').toString();
}

/**
 * SPEC-009 BR-009-13 / AC-11 — the holdings that could not be valued, gathered
 * where someone reading valuations will meet them. They are in the totals
 * above at acquisition cost, which is why this is said next to them. Moved
 * here with the "Visão geral" table it used to sit under.
 */
async function Unpriced({ holdings }: { readonly holdings: readonly ReportHolding[] }) {
  const t = await getTranslations('reports');
  const tp = await getTranslations('portfolio');
  const unpriced = holdings.filter((holding) => holding.needsAttention !== null);
  if (unpriced.length === 0) return null;

  // SPEC-022 BR-022-18 — it grows with the portfolio, so it is a table: paged,
  // filtered by asset, sorted. The markers are server-rendered cells.
  const rows: NodeRow[] = unpriced.map((holding, index) => ({
    id: `${holding.assetId}-${index}`,
    keys: { asset: holding.assetCode },
    cells: {
      asset: <span className="font-medium">{holding.assetCode}</span>,
      markers: <HoldingMarkers holding={holding} />,
    },
  }));

  return (
    <Section title={t('attentionTitle')} description={t('attentionDescription')}>
      <NodeTable
        columns={[
          { id: 'asset', header: tp('patrimonio.unpricedAsset'), kind: 'text', sortable: true },
          // The markers are badges that wrap among themselves, so the column is
          // wide rather than truncating (`control` never truncates).
          { id: 'markers', header: tp('patrimonio.unpricedMarkers'), kind: 'control', width: 40 },
        ]}
        rows={rows}
        caption={t('attentionTitle')}
        noun={tp('patrimonio.unpricedNoun')}
        filterPlaceholder={tp('patrimonio.unpricedFilterPlaceholder')}
        paramPrefix="unpriced"
        sort={{ id: 'asset', desc: false }}
      />
    </Section>
  );
}

/**
 * SPEC-011 BR-011-12 — the grouped export, of what this tab shows: today's
 * holdings in this scope, by asset class. The single-day period is the one the
 * tab itself reads (`loadCurrentComposition`), so the file and the screen are
 * the same figures. Never masked (BR-022-27): an export is a request for the
 * data.
 */
async function ExportLink({ walletId }: { readonly walletId: string | null }) {
  const t = await getTranslations('reports');
  const today = new SystemClock().today();
  const params = new URLSearchParams({
    period: 'custom',
    from: today,
    to: today,
    grouping: 'asset_class',
  });
  if (walletId !== null) params.set('wallet', walletId);

  return (
    <Button asChild variant="outline">
      <a href={`/api/reports/export?${params.toString()}`}>{t('export.csv')}</a>
    </Button>
  );
}
