import { getTranslations } from 'next-intl/server';
import { defaultGroupingFor, type GroupNames } from '@/core/reporting/grouping';
import {
  GROUPINGS,
  NOT_CLASSIFIED_GROUP_ID,
  type GroupKey,
  type Grouping,
  type ReportGroup,
} from '@/core/reporting/ports';
import { Money as MoneyValue } from '@/core/shared/money';
import type { CompositionReport } from '@/core/reporting/composition/ports';
import { assetClassColor, chartColorAt } from '@/components/charts/palette';
import { formatPercent } from '@/i18n/format';
import { fromSearchParams, PARAM } from '@/lib/report-url-state';
import { hasFixedIncome } from '@/lib/fixed-income';
import { ReportEmptyState } from '@/app/(app)/reports/_components/ReportEmptyState';
import { resolveGroupLabel } from '@/app/(app)/reports/_components/GroupLabel';
import { HoldingMarkers } from '@/app/(app)/reports/_components/HoldingMarkers';
import { tryUserId } from '@/lib/session';
import { loadCurrentComposition } from '@/app/(app)/portfolio/data';
import { loadWatchStates } from '@/app/(app)/watch/data';
import { PortfolioFrame } from '@/app/(app)/portfolio/_components/PortfolioFrame';
import { holdingRows, holdingsTableLabels } from '@/app/(app)/portfolio/_components/holding-rows';
import {
  ShareChart,
  type ShareChartSlice,
} from '@/app/(app)/portfolio/composition/_components/ShareChart';
import { HoldingsTable } from '@/app/(app)/portfolio/composition/_components/HoldingsTable';
import { PageShell } from '@/app/page-shell';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { ErrorState } from '@/components/patterns/error-state';
import { Field } from '@/components/patterns/field';
import { Money } from '@/app/money';
import { loadHideValues } from '@/app/hide-values';
import { concealSeries } from '@/app/chart-series';
import { Note } from '@/components/patterns/note';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { List, ListItem } from '@/components/layout/list';
import { ChartLegend } from '@/components/charts/chart-legend';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/native-select';
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
 * SPEC-015 — **Composição**, as Portfólio's second tab (SPEC-022 BR-022-02).
 *
 * The simplest of the reports and the most used: a share-of-total ring, a
 * sortable table of every holding, and the one flag in this product that comes
 * close to an opinion — kept informational by BR-015-06 and by the wording in
 * the message catalogue, which is reviewed by a human rather than asserted by
 * a test.
 *
 * **Current composition only** (#208). The page lived at
 * `/reports/composition` with a period control; a composition is a fact about
 * today, and the one period-bound part of it — the drift across a period,
 * BR-015-04 — moved to Relatórios › Evolução patrimonial (BR-022-03, #209). The
 * old URL redirects here (BR-022-08). The scope is the frame's
 * selector; **Agrupar por** stays, because a grouping is not a period: it
 * re-partitions today's figures without changing them (BR-011-08).
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
  const tCommon = await getTranslations('common');
  const tc = await getTranslations('composicao');
  const tp = await getTranslations('portfolio');
  // SPEC-018 BR-018-19: the badge reuses the rules screen's own state labels rather
  // than a second set here, so one state never has two names (AR-44).
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
  const params = {
    get: (name: string) => {
      const value = raw[name];
      return typeof value === 'string' ? value : null;
    },
  };

  // Parsed twice on purpose: the default grouping depends on the scope
  // (BR-011-04), and the scope is itself one of the parsed values. The period
  // the parser also reads is ignored: this tab takes none (BR-022-02).
  const provisional = fromSearchParams(params, 'asset_class');
  const state = fromSearchParams(params, defaultGroupingFor(provisional.scope, undefined));

  const { wallets, query, report, lastImportAt } = await loadCurrentComposition(userId, {
    scope: state.scope,
    grouping: state.grouping,
  });

  /*
   * SPEC-018 BR-018-19 — the watch state as a badge in the holdings list.
   * Read after the report rather than inside the loader: it is not part of
   * the composition report (nothing about a share of *patrimônio* depends on
   * it), and folding it in would put an opportunity read behind SPEC-015's
   * own cache and scope rules. Empty for a user who watches nothing, which is
   * every user until they configure a rule.
   */
  const watchStates = await loadWatchStates(userId);

  const labelOf = (key: GroupKey, names: GroupNames): string => resolveGroupLabel(key, names, t);

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
    >
      <GroupingForm
        grouping={state.grouping}
        walletId={state.scope.kind === 'wallet' ? state.scope.walletId : null}
      />

      {!query.ok ? (
        // BR-011-16: a named, explanatory outcome — never a blank page and
        // never a zero that looks like a real figure. The period is built
        // from the clock, so a missing wallet is the only reachable failure.
        <ErrorState title={t('scope.walletNotFound')} />
      ) : query.value.empty || report === null ? (
        <ReportEmptyState scoped={state.scope.kind === 'wallet'} />
      ) : (
        <Stack gap="lg">
          <Section title={tc('groups.title')} description={tc('groups.description')}>
            <ChartOfShares report={report} names={query.value.groupNames} labelOf={labelOf} />
            {/* SPEC-009 BR-009-12: grouped values also include gross fixed income. */}
            {hasFixedIncome(report.rows.map((row) => row.assetClass)) && (
              <Note>{t('grossOfTax')}</Note>
            )}
            <GroupsTable
              report={report}
              groups={query.value.report.groups}
              names={query.value.groupNames}
              labelOf={labelOf}
            />
          </Section>

          <Section title={tc('holdings.title')} description={tc('holdings.description')}>
            <HoldingsTable
              rows={holdingRows(report.rows, watchStates, t, tc, tw, masked)}
              labels={holdingsTableLabels(report, t, tc, tCommon)}
            />
            {/* SPEC-009 BR-009-12 / AC-10: fixed income is gross — nothing in
                this product deducts tax, and the figures must say so where
                they are read: in the panel that lists them (BR-022-36). */}
            {hasFixedIncome(report.rows.map((row) => row.assetClass)) && (
              <Note>{t('grossOfTax')}</Note>
            )}
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
        </Stack>
      )}
    </PortfolioFrame>
  );
}

/**
 * BR-011-03 — **Agrupar por**, the one control this tab keeps. A plain GET form
 * for the reason `reports/_components/Controls.tsx` gives (the state is the
 * URL, and it works without JavaScript); the scope rides along as a hidden
 * field so applying a grouping never drops the wallet the header selected
 * (BR-022-17).
 */
async function GroupingForm({
  grouping,
  walletId,
}: {
  readonly grouping: Grouping;
  readonly walletId: string | null;
}) {
  const t = await getTranslations('reports');

  return (
    <form
      method="get"
      action="/portfolio/composition"
      aria-label={t('grouping.label')}
      // Remounted when the header's scope changes the resolved grouping, so
      // the uncontrolled select cannot keep showing the old one (see
      // `reports/_components/Controls.tsx`).
      key={`${walletId ?? ''}|${grouping}`}
    >
      {walletId !== null && <input type="hidden" name={PARAM.wallet} value={walletId} />}
      {/* SPEC-022 BR-022-36 — a controls bar on the card layer, like
          Relatórios' `Controls`: it stays available on an empty scope, where
          there is no panel to carry it. */}
      <Card>
        <CardContent>
          <Cluster gap="sm" align="end">
            <Field id="composition-grouping" label={t('grouping.label')} width="lg">
              <NativeSelect name={PARAM.grouping} defaultValue={grouping}>
                {GROUPINGS.map((dimension) => (
                  <option key={dimension} value={dimension}>
                    {t(`grouping.${dimension}`)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Button type="submit">{t('apply')}</Button>
          </Cluster>
        </CardContent>
      </Card>
    </form>
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
  const masked = await loadHideValues();

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
        // SPEC-022 BR-022-24: the ring's arcs are proportions, so they survive
        // the rescale unchanged; only the amounts behind them are removed.
        slices={concealSeries(wedges, ['value'], masked)}
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
 *
 * SPEC-011 BR-011-07 — **a group row drills down to its constituent assets
 * without leaving the report.** It lived on Relatórios' Visão geral until
 * that tab left (SPEC-022 BR-022-03, #209); this is the grouped view now.
 * `<details>` rather than client state: the constituents already travel with
 * the group (`ReportGroup.holdings`), so expanding needs no second query —
 * a drill-down that re-queried could show figures derived differently from
 * the row it expands.
 */
async function GroupsTable({
  report,
  groups,
  names,
  labelOf,
}: {
  readonly report: CompositionReport;
  readonly groups: readonly ReportGroup[];
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
          <TableRow key={slice.key.id} className="align-top">
            <TableCell className="py-row">
              <details>
                <summary className="cursor-pointer">{labelOf(slice.key, names)}</summary>
                <List gap="none">
                  {(
                    groups.find(
                      (group) =>
                        group.key.dimension === slice.key.dimension &&
                        group.key.id === slice.key.id,
                    )?.holdings ?? []
                  ).map((holding, index) => (
                    <ListItem
                      key={`${holding.assetId}-${holding.institutionId ?? NOT_CLASSIFIED_GROUP_ID}-${index}`}
                    >
                      <Cluster gap="sm" align="baseline">
                        <Text as="span" size="xs" tone="muted">
                          {holding.assetCode} · <Money value={holding.quantity} kind="quantity" /> ·{' '}
                          <Money value={holding.value} />
                        </Text>
                        <HoldingMarkers holding={holding} />
                      </Cluster>
                    </ListItem>
                  ))}
                </List>
              </details>
            </TableCell>
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
          <TableCell className="py-row text-right">
            <Money value={WHOLE} kind="percent" />
          </TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  );
}

/** The scope's share of itself, through the same formatter as every slice. */
const WHOLE = MoneyValue.fromString('1');

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
