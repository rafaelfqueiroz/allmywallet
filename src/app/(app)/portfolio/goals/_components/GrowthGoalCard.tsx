import { getTranslations } from 'next-intl/server';
import { GrowthUnavailable } from '@/core/goals/ports';
import type { GoalView } from '@/app/(app)/wallets/goals-data';
import type { GrowthPoint } from '@/core/goals/growth-progress';
import type { Money as MoneyValue } from '@/core/shared/money';
import {
  GrowthChart,
  type GrowthChartPoint,
} from '@/app/(app)/portfolio/goals/_components/GrowthChart';
import { AchievedMarker } from '@/app/(app)/portfolio/goals/_components/AchievedMarker';
import { EditDeleteForms } from '@/app/(app)/portfolio/goals/_components/GoalEditDeleteForms';
import { Section } from '@/components/patterns/section';
import { EstimateMarker } from '@/components/patterns/estimate-marker';
import { EmptyState } from '@/components/patterns/empty-state';
import { StatCard } from '@/components/patterns/stat-card';
import { Money } from '@/app/money';
import { loadHideValues } from '@/app/hide-values';
import { chartTip, concealSeries } from '@/app/chart-series';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Grid } from '@/components/layout/grid';
import { Text } from '@/components/ui/text';
import { formatBusinessDate } from '@/i18n/format';
import { NodeTable, type NodeColumn, type NodeRow } from '@/components/patterns/node-table';
import { ranksOf, rankKeys } from '@/lib/rank-keys';

/**
 * SPEC-019 BR-019-09..13 / AC-1, AC-4, AC-14/15 — one growth goal, charted on
 * its own card.
 *
 * `goalView.growth` is `null` only when the contract's `GoalView` describes an
 * earnings-kind goal (`GoalsView` in `goals-data.ts`); the caller filters by
 * `kind` before rendering this, so the null branch below is defensive rather
 * than a state this component expects to reach.
 */
export async function GrowthGoalCard({ goalView }: { readonly goalView: GoalView }) {
  const { goal, growth } = goalView;
  if (growth === null || goal.basis === null) return null;

  const t = await getTranslations('objetivos');
  const tCommon = await getTranslations('common');

  // SPEC-022 BR-022-24: rescaled when masked — the line and the goal keep
  // their relation, and no amount reaches the browser.
  const masked = await loadHideValues();
  const points: GrowthChartPoint[] = concealSeries(
    growth.series.map((point) => ({
      date: point.date,
      value: point.kind === 'available' ? Number(point.value.toString()) : null,
      goal: Number(growth.goalAmount.toString()),
      tip: chartTip(
        formatBusinessDate(point.date),
        { value: point.kind === 'available' ? point.value : null, goal: growth.goalAmount },
        masked,
      ),
    })),
    ['value', 'goal'],
    masked,
  );

  // BR-019-12 / CR-1 — marked beside the chart, not in a footnote read once
  // and never again (patrimonio's `ValueChart` does the same for the same
  // reason: accrued fixed income is computed, not observed).
  const hasEstimated = growth.series.some((point) => point.kind === 'available' && point.estimated);

  // SPEC-022 BR-022-18 — the series grows with the goal's age (one row a day,
  // a week or a month), so it is a paged, sortable table on fixed widths: the
  // eye toggle (BR-022-24) moves none of its columns. The rank is the sort key
  // of the value column — the amount itself never becomes a number (AR-06–10);
  // a date with no value has no rank and sorts last in both directions.
  const valueRanks = ranksOf(growth.series, (point) =>
    point.kind === 'available' ? point.value : null,
  );
  const statusOf = (point: GrowthPoint): string =>
    // The two absences are different sentences and are told apart here: a cost
    // that was never recorded, versus a date with neither a price nor a cost
    // to fall back to. One shared "indisponível" would leave a user unable to
    // tell which of the two they are looking at, and only one of them is fixed
    // by recording an allocation's cost.
    point.kind === 'unavailable'
      ? point.reason === GrowthUnavailable.PRICE_UNAVAILABLE
        ? t('growth.table.priceUnavailable')
        : t('growth.table.unavailable')
      : point.estimated
        ? tCommon('valueEstimated')
        : t('growth.table.observed');
  const seriesColumns: NodeColumn[] = [
    { id: 'date', header: t('growth.table.date'), kind: 'date', sortable: true },
    { id: 'value', header: t('growth.table.value'), kind: 'money', sortable: true },
    // The longest sentence is "Indisponível — sem preço no dia e sem custo registrado": it
    // ends in an ellipsis with its full text on demand rather than widening the column.
    { id: 'status', header: t('growth.table.status'), kind: 'text', width: 30, sortable: true },
  ];
  const seriesRows: NodeRow[] = growth.series.map((point, index) => {
    const status = statusOf(point);
    return {
      id: point.date,
      keys: { date: point.date, status, ...rankKeys({ value: valueRanks }, index) },
      cells: {
        date: formatBusinessDate(point.date),
        value:
          point.kind === 'available' ? (
            <Money value={point.value} />
          ) : (
            <Text as="span" tone="muted" size="sm">
              {t('growth.table.unavailableShort')}
            </Text>
          ),
        // SPEC-022 BR-022-32 — an estimated day carries the marker and its
        // explanation; the label text stays the sort key.
        status:
          point.kind === 'available' && point.estimated ? (
            <EstimateMarker kind="value" explanation={t('growth.estimatedHint')} />
          ) : (
            status
          ),
      },
    };
  });

  return (
    <Section
      title={goal.name}
      description={t(goal.basis === 'invested' ? 'basisInvested' : 'basisCurrentValue')}
      // The goal's own edit and delete are actions that apply to the whole
      // block, so they are the panel's footer (DS-46) — a table closes its panel
      // with its pager, and nothing may follow it inside (BR-022-36).
      footer={
        <EditDeleteForms
          goalId={goal.id}
          walletId={goal.walletId}
          name={goal.name}
          amount={goal.amount}
          t={t}
        />
      }
    >
      <AchievedMarker achievedOn={goal.achievedOn} currentlyAchieved={growth.achieved} />

      {growth.current === null ? (
        // BR-019-09 — no allocation ever recorded for this wallet: there is
        // no line to draw, which is a different statement from a line at
        // zero.
        <EmptyState title={t('growth.noHistory')} />
      ) : (
        <>
          <Grid cols={3} gap="md">
            <StatCard
              inset
              label={t('growth.currentLabel')}
              value={
                growth.current.kind === 'available' ? (
                  <Money value={growth.current.value} />
                ) : (
                  <Text as="span" tone="muted" size="sm">
                    {t('growth.unavailable')}
                  </Text>
                )
              }
            />
            <StatCard
              inset
              label={t('growth.goalLabel')}
              value={<Money value={growth.goalAmount} />}
            />
            <StatCard
              inset
              label={t('growth.progressLabel')}
              value={
                growth.ratio === null ? (
                  <Text as="span" tone="muted" size="sm">
                    {t('growth.unavailable')}
                  </Text>
                ) : (
                  <Money value={growth.ratio} kind="percent" />
                )
              }
            />
          </Grid>

          <Stack gap="sm">
            <GrowthChart
              masked={masked}
              points={points}
              title={t('growth.chartTitle', { name: goal.name })}
              summary={
                <GrowthSummary
                  series={growth.series}
                  goalAmount={growth.goalAmount}
                  labels={{
                    empty: t('growth.chartSummaryEmpty'),
                    from: t('growth.chartFrom'),
                    to: t('growth.chartTo'),
                    goal: t('growth.chartGoal'),
                  }}
                />
              }
              labels={{ value: t('growth.valueLineLabel'), goal: t('growth.goalLineLabel') }}
            />
            {hasEstimated && (
              <Cluster gap="sm">
                <EstimateMarker kind="value" explanation={t('growth.estimatedHint')} />
              </Cluster>
            )}
          </Stack>

          {/* SPEC-016 BR-016-16 / AC-18 — the chart's text equivalent. Every
                point the line draws is also a row here, with its status; the
                pager reaches the ones past the first page. */}
          <NodeTable
            columns={seriesColumns}
            rows={seriesRows}
            caption={t('growth.table.caption')}
            noun={t('growth.table.noun')}
            sort={{ id: 'date', desc: true }}
            // One per goal: a wallet can hold several growth goals, and a shared
            // prefix would page, sort and size them all together (BR-022-18).
            paramPrefix={`growth-${goal.id}`}
          />
        </>
      )}
    </Section>
  );
}

/** The chart's short prose alternative — the whole series lives in the table below. */
function GrowthSummary({
  series,
  goalAmount,
  labels,
}: {
  readonly series: readonly GrowthPoint[];
  readonly goalAmount: MoneyValue;
  readonly labels: {
    readonly empty: string;
    readonly from: string;
    readonly to: string;
    readonly goal: string;
  };
}) {
  const available = series.filter(
    (point): point is Extract<GrowthPoint, { kind: 'available' }> => point.kind === 'available',
  );
  const first = available[0];
  const last = available.at(-1);
  if (first === undefined || last === undefined) return <span>{labels.empty}</span>;

  return (
    <span>
      {labels.from} {formatBusinessDate(first.date)} <Money value={first.value} /> — {labels.to}{' '}
      {formatBusinessDate(last.date)} <Money value={last.value} />. {labels.goal}{' '}
      <Money value={goalAmount} />.
    </span>
  );
}
