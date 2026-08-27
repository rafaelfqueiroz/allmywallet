import { getTranslations } from 'next-intl/server';
import { GrowthUnavailable } from '@/core/goals/ports';
import type { GoalView } from '@/app/(app)/wallets/goals-data';
import type { GrowthPoint } from '@/core/goals/growth-progress';
import type { Money as MoneyValue } from '@/core/shared/money';
import {
  GrowthChart,
  type GrowthChartPoint,
} from '@/app/(app)/wallets/[walletId]/goals/_components/GrowthChart';
import { AchievedMarker } from '@/app/(app)/wallets/[walletId]/goals/_components/AchievedMarker';
import { EditDeleteForms } from '@/app/(app)/wallets/[walletId]/goals/_components/GoalEditDeleteForms';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { StatCard } from '@/components/patterns/stat-card';
import { Money } from '@/components/patterns/money';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Grid } from '@/components/layout/grid';
import { Badge } from '@/components/ui/badge';
import { Text } from '@/components/ui/text';
import { formatBusinessDate } from '@/i18n/format';
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

  const points: GrowthChartPoint[] = growth.series.map((point) => ({
    date: point.date,
    value: point.kind === 'available' ? Number(point.value.toString()) : null,
    goal: Number(growth.goalAmount.toString()),
  }));

  // BR-019-12 / CR-1 — marked beside the chart, not in a footnote read once
  // and never again (patrimonio's `ValueChart` does the same for the same
  // reason: accrued fixed income is computed, not observed).
  const hasEstimated = growth.series.some((point) => point.kind === 'available' && point.estimated);

  return (
    <Section
      title={goal.name}
      description={t(goal.basis === 'invested' ? 'basisInvested' : 'basisCurrentValue')}
    >
      <Stack gap="md">
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
              <StatCard label={t('growth.goalLabel')} value={<Money value={growth.goalAmount} />} />
              <StatCard
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
                  <Badge variant="outline" title={t('growth.estimatedHint')}>
                    {t('growth.estimatedBadge')}
                  </Badge>
                </Cluster>
              )}
            </Stack>

            {/* SPEC-016 BR-016-16 / AC-18 — the chart's text equivalent. Every
                point the line draws is also a row here, with its status. */}
            <Table>
              <TableCaption className="sr-only">{t('growth.table.caption')}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t('growth.table.date')}</TableHead>
                  <TableHead scope="col" className="text-right">
                    {t('growth.table.value')}
                  </TableHead>
                  <TableHead scope="col">{t('growth.table.status')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {growth.series.map((point) => (
                  <TableRow key={point.date}>
                    <TableHead scope="row" className="text-left font-normal">
                      {formatBusinessDate(point.date)}
                    </TableHead>
                    <TableCell className="text-right">
                      {point.kind === 'available' ? (
                        <Money value={point.value} />
                      ) : (
                        <Text as="span" tone="muted" size="sm">
                          {t('growth.table.unavailableShort')}
                        </Text>
                      )}
                    </TableCell>
                    {/*
                      The two absences are different sentences and are told
                      apart here: a cost that was never recorded, versus a date
                      with neither a price nor a cost to fall back to. One
                      shared "indisponível" would leave a user unable to tell
                      which of the two they are looking at, and only one of
                      them is fixed by recording an allocation's cost.
                    */}
                    <TableCell>
                      {point.kind === 'unavailable'
                        ? point.reason === GrowthUnavailable.PRICE_UNAVAILABLE
                          ? t('growth.table.priceUnavailable')
                          : t('growth.table.unavailable')
                        : point.estimated
                          ? t('growth.table.estimated')
                          : t('growth.table.observed')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}

        <EditDeleteForms
          goalId={goal.id}
          walletId={goal.walletId}
          name={goal.name}
          amount={goal.amount}
          t={t}
        />
      </Stack>
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
