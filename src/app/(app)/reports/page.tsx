import { getTranslations } from 'next-intl/server';
import { SystemClock } from '@/core/shared/clock';
import { runReportQuery } from '@/core/reporting/base-query';
import { defaultGroupingFor } from '@/core/reporting/grouping';
import {
  NOT_CLASSIFIED_GROUP_ID,
  UNASSIGNED_GROUP_ID,
  type ReportGroup,
} from '@/core/reporting/ports';
import { fromSearchParams } from '@/lib/report-url-state';
import { hasFixedIncome } from '@/lib/fixed-income';
import { Controls } from '@/app/(app)/reports/_components/Controls';
import { ReportEmptyState } from '@/app/(app)/reports/_components/ReportEmptyState';
import { ReportNav } from '@/app/(app)/reports/_components/ReportNav';
import { withReportPort } from '@/app/(app)/reports/data';
import { tryUserId } from '@/app/(app)/reports/session';
import { PageShell } from '@/components/patterns/page-shell';
import { EmptyState } from '@/components/patterns/empty-state';
import { ErrorState } from '@/components/patterns/error-state';
import { Money } from '@/components/patterns/money';
import { Note } from '@/components/patterns/note';
import { Stack } from '@/components/layout/stack';
import { Badge } from '@/components/ui/badge';
import { List, ListItem } from '@/components/layout/list';
import { Text } from '@/components/ui/text';
import { Cluster } from '@/components/layout/cluster';
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
 * SPEC-011 — the reporting framework's own page: the shared controls, the
 * grouped table and the empty states, exercised end to end.
 *
 * SPEC-012 through SPEC-015 build their reports on the same
 * `runReportQuery` + `Controls` pair, which is what makes BR-011-06's "same
 * control, same options, same semantics" hold across all four.
 *
 * Never statically prerendered: this renders one tenant's own holdings, so a
 * cached copy built once (or with no session) would be served to everyone —
 * the same reasoning as `(app)/wallets/page.tsx`.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ReportsPage({ searchParams }: PageProps) {
  const t = await getTranslations('reports');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell width="wide" title={t('title')}>
        <EmptyState title={t('signedOut')} />
      </PageShell>
    );
  }

  const raw = await searchParams;
  // BR-011-11: the three controls are read from the URL, so a bookmark
  // reproduces the view exactly.
  const params = {
    get: (name: string) => {
      const value = raw[name];
      return typeof value === 'string' ? value : null;
    },
  };

  // Parsed twice on purpose: the default grouping depends on the scope
  // (BR-011-04), and the scope is itself one of the parsed values.
  const provisional = fromSearchParams(params, 'asset_class');
  const state = fromSearchParams(params, defaultGroupingFor(provisional.scope, undefined));

  const { result, wallets } = await withReportPort(userId, async (port) => ({
    wallets: await port.listWallets(),
    result: await runReportQuery(
      port,
      {
        period: state.period,
        scope: state.scope,
        grouping: state.grouping,
        today: new SystemClock().today(),
      },
      await port.earliestSnapshotDate(),
    ),
  }));

  return (
    <PageShell width="wide" title={t('title')} description={t('description')}>
      <ReportNav current="/reports" />

      <Controls
        action="/reports"
        period={state.period}
        scope={state.scope}
        grouping={state.grouping}
        wallets={wallets.map((wallet) => ({ walletId: wallet.walletId, name: wallet.name }))}
      />

      {!result.ok ? (
        // BR-011-16: a named, explanatory outcome — never a blank page and
        // never a zero that looks like a real figure.
        <ErrorState
          title={
            result.error.code === 'REPORTING_INVALID_PERIOD_RANGE'
              ? t('period.invalidRange')
              : t('scope.walletNotFound')
          }
        />
      ) : result.value.empty ? (
        <ReportEmptyState scoped={state.scope.kind === 'wallet'} />
      ) : (
        <Stack gap="md">
          <Text tone="muted">
            {result.value.range.from} — {result.value.range.to}
          </Text>
          <Table>
            <TableCaption className="sr-only">
              {t(`grouping.${result.value.report.grouping}`)}
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t('table.group')}</TableHead>
                <TableHead scope="col" className="text-right">
                  {t('table.quantity')}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {t('table.value')}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {t('table.costBasis')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.value.report.groups.map((group: ReportGroup) => (
                <GroupRow key={group.key.id} group={group} />
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableHead scope="row" className="py-row text-left">
                  {t('table.total')}
                </TableHead>
                <TableCell className="py-row text-right">
                  <Money value={result.value.report.total.quantity} kind="quantity" />
                </TableCell>
                <TableCell className="py-row text-right">
                  <Money value={result.value.report.total.value} />
                </TableCell>
                <TableCell className="py-row text-right">
                  <Money value={result.value.report.total.costBasis} />
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>

          {/* SPEC-009 BR-009-12 / AC-10: fixed income is gross — nothing in
              this product deducts tax, and the figure above must say so where
              it is read rather than in a help page nobody opens. */}
          {hasFixedIncome(
            result.value.report.groups.flatMap((group: ReportGroup) =>
              group.holdings.map((holding) => holding.assetClass),
            ),
          ) && <Note>{t('grossOfTax')}</Note>}
        </Stack>
      )}
    </PageShell>
  );
}

/**
 * BR-011-07 / AC-9 — "a group row drills down to its constituent assets
 * without leaving the report."
 *
 * `<details>` rather than client-side state: the constituents already travel
 * with the group (`ReportGroup.holdings`), so expanding needs no second query
 * and therefore no JavaScript. A drill-down that re-queried could show figures
 * derived differently from the row it expands — which is exactly the class of
 * disagreement this spec exists to prevent.
 */
async function GroupRow({ group }: { readonly group: ReportGroup }) {
  const t = await getTranslations('reports');

  // AR-44: synthetic buckets render an i18n label, never their sentinel id.
  const label = group.key.synthetic
    ? group.key.id === UNASSIGNED_GROUP_ID
      ? t('group.unassigned')
      : t('group.notClassified')
    : group.key.dimension === 'asset_class'
      ? t(`assetClass.${group.key.id}`)
      : (group.holdings[0]?.assetCode ?? group.key.id);

  return (
    <TableRow className="align-top">
      <TableCell className="py-row">
        <details>
          <summary className="cursor-pointer">
            <Cluster gap="sm" align="baseline">
              <span>{label}</span>
              {group.totals.estimated ? (
                <Badge variant="outline" title={t('estimate.explanation')}>
                  {t('estimate.badge')}
                </Badge>
              ) : null}
            </Cluster>
          </summary>
          <List gap="none">
            {group.holdings.map((holding, index) => (
              <ListItem
                key={`${holding.assetId}-${holding.institutionId ?? NOT_CLASSIFIED_GROUP_ID}-${index}`}
              >
                <Text as="span" size="xs" tone="muted">
                  {holding.assetCode} · <Money value={holding.quantity} kind="quantity" /> ·{' '}
                  <Money value={holding.value} />
                </Text>
              </ListItem>
            ))}
          </List>
        </details>
      </TableCell>
      <TableCell className="py-row text-right">
        <Money value={group.totals.quantity} kind="quantity" />
      </TableCell>
      <TableCell className="py-row text-right">
        <Money value={group.totals.value} />
      </TableCell>
      <TableCell className="py-row text-right">
        <Money value={group.totals.costBasis} />
      </TableCell>
    </TableRow>
  );
}

/**
 * BR-011-16 / AC-14 — an empty scope gets an explanation, never a misleading
 * zero. The wording differs by scope because the useful next action does: an
 * empty portfolio needs an import, an empty wallet needs an allocation.
 */
