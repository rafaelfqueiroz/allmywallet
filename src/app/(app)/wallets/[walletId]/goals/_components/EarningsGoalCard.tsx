import { getTranslations } from 'next-intl/server';
import type { GoalView } from '@/app/(app)/wallets/goals-data';
import type { EarningsMonth, EarningsProgress } from '@/core/goals/earnings-progress';
import {
  EarningsGoalChart,
  type EarningsChartPoint,
} from '@/app/(app)/wallets/[walletId]/goals/_components/EarningsGoalChart';
import { AchievedMarker } from '@/app/(app)/wallets/[walletId]/goals/_components/AchievedMarker';
import { EditDeleteForms } from '@/app/(app)/wallets/[walletId]/goals/_components/GoalEditDeleteForms';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { StatCard } from '@/components/patterns/stat-card';
import { Money } from '@/components/patterns/money';
import { Stack } from '@/components/layout/stack';
import { Grid } from '@/components/layout/grid';
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
 * SPEC-019 BR-019-14..22 / AC-1, AC-7..12, AC-14/15 — one earnings goal,
 * charted for the wallet-page's currently selected year.
 *
 * `goalView.earnings` is `null` only when the contract's `GoalView` describes
 * a growth-kind goal; the caller filters by `kind` before rendering this.
 */
export async function EarningsGoalCard({ goalView }: { readonly goalView: GoalView }) {
  const { goal, earnings } = goalView;
  if (earnings === null || goal.period === null) return null;

  const t = await getTranslations('objetivos');
  const periodLabel = t(goal.period === 'monthly' ? 'periodMonthly' : 'periodYearly');

  return (
    <Section title={goal.name} description={periodLabel}>
      <Stack gap="md">
        <AchievedMarker achievedOn={goal.achievedOn} currentlyAchieved={earnings.achieved} />

        {/* BR-019-21 / AC-12 — an explanation, never twelve zero bars. `months`
            is empty in this state, so there is nothing to chart regardless. */}
        {earnings.empty ? (
          <EmptyState title={t('earnings.empty', { year: earnings.year })} />
        ) : (
          <EarningsBody goal={goal} earnings={earnings} t={t} />
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

function EarningsBody({
  goal,
  earnings,
  t,
}: {
  readonly goal: GoalView['goal'];
  readonly earnings: EarningsProgress;
  readonly t: Awaited<ReturnType<typeof getTranslations>>;
}) {
  const goalAmountNumber = Number(earnings.goalAmount.toString());

  const points: EarningsChartPoint[] = earnings.months.map((month) => ({
    month: month.month,
    amount: month.kind === 'elapsed' ? Number(month.amount.toString()) : null,
    cumulative: month.kind === 'elapsed' ? Number(month.cumulative.toString()) : null,
    yearToDateAverage: month.kind === 'elapsed' ? Number(month.yearToDateAverage.toString()) : null,
    goal: goalAmountNumber,
  }));

  return (
    <>
      <Grid cols={3} gap="md">
        <StatCard
          label={
            earnings.highlight.kind === 'current_month'
              ? t('earnings.highlightCurrentMonth', { month: earnings.highlight.month })
              : t('earnings.highlightYearTotal', { year: earnings.highlight.year })
          }
          value={<Money value={earnings.highlight.amount} />}
        />
        <StatCard label={t('earnings.goalLabel')} value={<Money value={earnings.goalAmount} />} />
        <StatCard label={t('earnings.totalLabel')} value={<Money value={earnings.total} />} />
      </Grid>

      <EarningsGoalChart
        points={points}
        period={goal.period === 'yearly' ? 'yearly' : 'monthly'}
        title={t('earnings.chartTitle', { name: goal.name, year: earnings.year })}
        summary={
          <EarningsSummary
            earnings={earnings}
            labels={{
              total: t('earnings.chartSummaryTotal'),
              average: t('earnings.chartSummaryAverage'),
              goal: t('earnings.chartSummaryGoal'),
            }}
          />
        }
        labels={{
          bars: t('earnings.barsLabel'),
          average: t('earnings.yearToDateAverageLabel'),
          cumulative: t('earnings.cumulativeLabel'),
          goal: t(
            goal.period === 'yearly'
              ? 'earnings.goalLineLabelYearly'
              : 'earnings.goalLineLabelMonthly',
          ),
        }}
      />

      {/* SPEC-016 BR-016-16 / AC-18 — every month's figures, as text. A
          `not_elapsed` month gets one cell saying so, never three fabricated
          zeros (BR-019-19 also lives here: only the selected year's twelve
          months are ever rows in this table). */}
      <Table>
        <TableCaption className="sr-only">{t('earnings.table.caption')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('earnings.table.month')}</TableHead>
            <TableHead scope="col" className="text-right">
              {t('earnings.table.amount')}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {t('earnings.table.cumulative')}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {t('earnings.table.yearToDateAverage')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {earnings.months.map((month) => (
            <TableRow key={month.month}>
              <TableHead scope="row" className="text-left font-normal">
                {month.month}
              </TableHead>
              {month.kind === 'not_elapsed' ? (
                <TableCell colSpan={3} className="text-right">
                  <Text as="span" tone="muted" size="sm">
                    {t('earnings.table.notElapsed')}
                  </Text>
                </TableCell>
              ) : (
                <>
                  <TableCell className="text-right">
                    <Money value={month.amount} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={month.cumulative} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={month.yearToDateAverage} />
                  </TableCell>
                </>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}

/** The chart's short prose alternative — the whole month-by-month series lives in the table below. */
function EarningsSummary({
  earnings,
  labels,
}: {
  readonly earnings: EarningsProgress;
  readonly labels: { readonly total: string; readonly average: string; readonly goal: string };
}) {
  const lastElapsed = [...earnings.months]
    .reverse()
    .find(
      (month): month is Extract<EarningsMonth, { kind: 'elapsed' }> => month.kind === 'elapsed',
    );

  return (
    <span>
      {labels.total} <Money value={earnings.total} />
      {lastElapsed !== undefined && (
        <>
          {' — '}
          {labels.average} <Money value={lastElapsed.yearToDateAverage} />
        </>
      )}
      . {labels.goal} <Money value={earnings.goalAmount} />.
    </span>
  );
}
