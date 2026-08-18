import { getTranslations } from 'next-intl/server';
import { SystemClock } from '@/core/shared/clock';
import { runReportQuery } from '@/core/reporting/base-query';
import type { GroupNames } from '@/core/reporting/grouping';
import { GroupLabel } from '@/app/(app)/reports/_components/GroupLabel';
import { defaultGroupingFor } from '@/core/reporting/grouping';
import { NOT_CLASSIFIED_GROUP_ID, type ReportGroup } from '@/core/reporting/ports';
import { fromSearchParams, toQueryString } from '@/lib/report-url-state';
import { hasFixedIncome } from '@/lib/fixed-income';
import { Controls } from '@/app/(app)/reports/_components/Controls';
import { ReportEmptyState } from '@/app/(app)/reports/_components/ReportEmptyState';
import { ReportNav } from '@/app/(app)/reports/_components/ReportNav';
import { HoldingMarkers } from '@/app/(app)/reports/_components/HoldingMarkers';
import { withReportPort } from '@/app/(app)/reports/data';
import { tryUserId } from '@/app/(app)/reports/session';
import { PageShell } from '@/components/patterns/page-shell';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { ErrorState } from '@/components/patterns/error-state';
import { Money } from '@/components/patterns/money';
import { Note } from '@/components/patterns/note';
import { Stack } from '@/components/layout/stack';
import { Badge } from '@/components/ui/badge';
import { List, ListItem } from '@/components/layout/list';
import { Text } from '@/components/ui/text';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
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
  // Hoisted, because the export link has to serialise against the *same*
  // default the state was parsed with. Passing `state.grouping` there would
  // omit the parameter every time — the two would always compare equal — and
  // the export would silently fall back to this scope's default grouping,
  // which is not necessarily what the table on screen is showing.
  const defaultGrouping = defaultGroupingFor(provisional.scope, undefined);
  const state = fromSearchParams(params, defaultGrouping);

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

      {/*
        BR-011-12 / AC-011-11 — the export, reachable. `exportGroupedCsv` was
        written, tested and referenced by nothing: no route, no control, and
        `reports.export.csv` unused in the catalogue, so the criterion was
        ticked on a function a user could not invoke (#61).

        A link rather than a button: the response is a file, the handler is a
        GET, and carrying the page's own query string is what makes "export
        what I am looking at" true rather than approximately true.
      */}
      {result.ok && !result.value.empty && (
        <Cluster gap="sm">
          <Button asChild variant="outline" size="sm">
            <a href={`/api/reports/export${toQueryString(state, defaultGrouping)}`}>
              {t('export.csv')}
            </a>
          </Button>
        </Cluster>
      )}

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
                <GroupRow key={group.key.id} group={group} names={result.value.groupNames} />
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

          {/* SPEC-009 BR-009-13 / AC-11 — the holdings that could not be
              valued, gathered where someone reading valuations will meet
              them. They are not hidden from the totals above: they are in
              there at acquisition cost, which is exactly why the totals need
              this said next to them rather than on a separate screen. */}
          {(() => {
            const unpriced = result.value.report.groups.flatMap((group: ReportGroup) =>
              group.holdings.filter((holding) => holding.needsAttention !== null),
            );
            if (unpriced.length === 0) return null;
            return (
              <Section title={t('attentionTitle')} description={t('attentionDescription')}>
                <List gap="sm">
                  {unpriced.map((holding, index) => (
                    <ListItem key={`${holding.assetId}-${index}`} separated>
                      <Cluster justify="between" gap="sm">
                        <span className="font-medium">{holding.assetCode}</span>
                        <HoldingMarkers holding={holding} />
                      </Cluster>
                    </ListItem>
                  ))}
                </List>
              </Section>
            );
          })()}

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
async function GroupRow({
  group,
  names,
}: {
  readonly group: ReportGroup;
  readonly names: GroupNames;
}) {
  const t = await getTranslations('reports');

  return (
    <TableRow className="align-top">
      <TableCell className="py-row">
        <details>
          <summary className="cursor-pointer">
            <Cluster gap="sm" align="baseline">
              <span>
                <GroupLabel groupKey={group.key} names={names} />
              </span>
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
                <Cluster gap="sm" align="baseline">
                  <Text as="span" size="xs" tone="muted">
                    {holding.assetCode} · <Money value={holding.quantity} kind="quantity" /> ·{' '}
                    <Money value={holding.value} />
                  </Text>
                  {/* SPEC-009 AC-3/9/11 — how this row was priced, on the row. */}
                  <HoldingMarkers holding={holding} />
                </Cluster>
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
