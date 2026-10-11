import type { ReactNode } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { ReportQueryResult } from '@/core/reporting/base-query';
import { UNASSIGNED_GROUP_ID, type ReportTotals } from '@/core/reporting/ports';
import type { CompositionReport, CompositionSlice } from '@/core/reporting/composition/ports';
import { unrealizedResult } from '@/core/reporting/composition/result';
import { Money as MoneyValue } from '@/core/shared/money';
import { labelFor, loadWalletsPageData } from '@/app/(app)/wallets/data';
import { loadCurrentComposition } from '@/app/(app)/portfolio/data';
import { PortfolioFrame } from '@/app/(app)/portfolio/_components/PortfolioFrame';
import { WalletBalance } from '@/app/(app)/portfolio/wallets/_components/WalletBalance';
import { EstimatedValue } from '@/app/(app)/portfolio/_components/EstimatedValue';
import { fromSearchParams } from '@/lib/report-url-state';
import { tryUserId } from '@/lib/session';
import { PageShell } from '@/app/page-shell';
import { Money } from '@/app/money';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { ErrorState } from '@/components/patterns/error-state';
import { CostEstimateMarker } from '@/components/patterns/cost-estimate-marker';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { List, ListItem } from '@/components/layout/list';
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
 * SPEC-022 BR-022-02 — **Portfólio › Carteiras**: how holdings spread across
 * wallets, the wallets compared, the Não atribuído bucket, and balancing
 * (SPEC-010, SPEC-017).
 *
 * - **All wallets** in the scope selector: the comparison and Não atribuído.
 *   The wallets asking for a decision are in Configurações › Carteiras › Atribuir ativos.
 * - **One wallet**: that wallet's row of the comparison, then its balancing
 *   (SPEC-017), which was `/wallets/[id]/balance` (redirected here,
 *   BR-022-08).
 *
 * **The comparison is by value, cost, result and share of the portfolio —
 * never by a quantity** (BR-022-34). The old table summed allocated
 * quantities across different assets: "Reserva de Oportunidade 30.500.000" was
 * a count of R$ 0,01 CDB units. Every figure now comes from SPEC-011's report
 * grouped by wallet (BR-010-20), the same holding set the Patrimônio tab
 * totals, so the wallets and Não atribuído sum to the portfolio exactly
 * (BR-011-08). No new calculation: the result is BR-015-08's subtraction at the
 * grain of a wallet (`core/reporting/composition/result.ts`).
 *
 * Allocation figures are only as correct as the allocations underneath them;
 * #197 overstates some wallets, and this tab does not change allocation logic.
 *
 * **Wallet setup is not here.** Creating, editing, deleting, assigning and the
 * standing rules are Configurações › Carteiras (#210, BR-022-05); this tab is
 * the analysis only, so it has no sub-tabs (BR-022-15).
 *
 * Never statically prerendered: one tenant's own holdings and allocations.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PortfolioWalletsPage({ searchParams }: PageProps) {
  const tp = await getTranslations('portfolio');
  const t = await getTranslations('reports');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell title={tp('title')}>
        <EmptyState title={tp('signedOut')} />
      </PageShell>
    );
  }

  const raw = await searchParams;
  const { scope } = fromSearchParams(
    {
      get: (name: string) => {
        const value = raw[name];
        return typeof value === 'string' ? value : null;
      },
    },
    'wallet',
  );

  // Always the whole portfolio, grouped by wallet: a wallet's share of the
  // portfolio is only defined against the portfolio, at either scope.
  const { wallets, query, report, lastImportAt } = await loadCurrentComposition(userId, {
    scope: { kind: 'portfolio' },
    grouping: 'wallet',
  });

  const comparison =
    query.ok && !query.value.empty && report !== null
      ? comparisonRows(wallets, report, query.value)
      : null;

  const frame = (children: ReactNode) => (
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
      {children}
    </PortfolioFrame>
  );

  if (scope.kind === 'wallet') {
    const row = comparison?.wallets.find((entry) => entry.walletId === scope.walletId);
    const balance = await WalletBalance({ userId, walletId: scope.walletId });
    if (balance === null) return frame(<ErrorState title={t('scope.walletNotFound')} />);

    return frame(
      <Stack gap="lg">
        {comparison !== null && row !== undefined && report !== null && (
          <ComparisonTable rows={[row]} total={null} />
        )}
        {balance}
      </Stack>,
    );
  }

  const { unassigned, labels } = await loadWalletsPageData(userId);

  return frame(
    <Stack gap="lg">
      <Section
        title={tp('wallets.comparisonTitle')}
        description={tp('wallets.comparisonDescription')}
      >
        {wallets.length === 0 ? (
          <EmptyState title={tp('wallets.empty')} />
        ) : comparison === null || report === null ? (
          <EmptyState title={t('empty.portfolioTitle')} description={t('empty.portfolioBody')} />
        ) : (
          <ComparisonTable
            rows={[
              ...comparison.wallets,
              ...(comparison.unassigned ? [comparison.unassigned] : []),
            ]}
            total={report.total}
          />
        )}
      </Section>

      <Section
        title={tp('wallets.unassignedTitle')}
        description={tp('wallets.unassignedDescription')}
      >
        {unassigned.length === 0 ? (
          <EmptyState title={tp('wallets.unassignedEmpty')} />
        ) : (
          // One asset per row, so a quantity here counts one thing (BR-022-34).
          <List gap="sm">
            {unassigned.map((holding) => {
              const label = labelFor(labels, holding.assetId);
              return (
                <ListItem key={holding.assetId} separated>
                  <Cluster justify="between" gap="sm">
                    <span>
                      {label.code} — {label.name}
                    </span>
                    <Money value={holding.quantity} kind="quantity" />
                  </Cluster>
                </ListItem>
              );
            })}
          </List>
        )}
      </Section>
    </Stack>,
  );
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

interface ComparisonRow {
  readonly walletId: string;
  /** Already resolved: the wallet's own name, or the translated Não atribuído. */
  readonly name: string;
  readonly synthetic: boolean;
  /** Distinct assets, never a sum of their quantities (BR-022-34). */
  readonly assets: number;
  /** `null` for a wallet holding nothing — not a zero (BR-011-16). */
  readonly slice: CompositionSlice | null;
}

/**
 * Every wallet, in the order the tenant listed them, then Não atribuído
 * (BR-010-06: always visible). A wallet with no allocation has no group in the
 * report, and renders as one holding nothing rather than disappearing.
 */
function comparisonRows(
  wallets: readonly { readonly walletId: string; readonly name: string }[],
  report: CompositionReport,
  query: ReportQueryResult,
): { readonly wallets: readonly ComparisonRow[]; readonly unassigned: ComparisonRow | null } {
  const assetsIn = (groupId: string): number => {
    const group = query.report.groups.find((entry) => entry.key.id === groupId);
    return group === undefined ? 0 : new Set(group.holdings.map((holding) => holding.assetId)).size;
  };

  const unassignedSlice =
    report.breakdown.find((slice) => slice.key.synthetic && slice.key.id === UNASSIGNED_GROUP_ID) ??
    null;

  return {
    wallets: wallets.map((wallet) => ({
      walletId: wallet.walletId,
      name: wallet.name,
      synthetic: false,
      assets: assetsIn(wallet.walletId),
      slice:
        report.breakdown.find(
          (slice) => !slice.key.synthetic && slice.key.id === wallet.walletId,
        ) ?? null,
    })),
    unassigned:
      unassignedSlice === null
        ? null
        : {
            walletId: UNASSIGNED_GROUP_ID,
            name: '',
            synthetic: true,
            assets: assetsIn(UNASSIGNED_GROUP_ID),
            slice: unassignedSlice,
          },
  };
}

async function ComparisonTable({
  rows,
  total,
}: {
  readonly rows: readonly ComparisonRow[];
  readonly total: ReportTotals | null;
}) {
  const tp = await getTranslations('portfolio');

  return (
    <Table>
      <TableCaption className="sr-only">{tp('wallets.comparisonTitle')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{tp('wallets.columnWallet')}</TableHead>
          <TableHead scope="col" className="text-right">
            {tp('wallets.columnAssets')}
          </TableHead>
          <TableHead scope="col" className="text-right">
            {tp('wallets.columnValue')}
          </TableHead>
          <TableHead scope="col" className="text-right">
            {tp('wallets.columnCost')}
          </TableHead>
          <TableHead scope="col" className="text-right">
            {tp('wallets.columnResult')}
          </TableHead>
          <TableHead scope="col" className="text-right">
            {tp('wallets.columnShare')}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.walletId}>
            <TableHead scope="row" className="py-row text-left font-medium">
              {row.synthetic ? (
                tp('wallets.unassignedTitle')
              ) : (
                <Link
                  href={`/portfolio/wallets?wallet=${row.walletId}`}
                  className="underline-offset-4 hover:underline"
                >
                  {row.name}
                </Link>
              )}
            </TableHead>
            <TableCell className="py-row text-right tabular-nums">{row.assets}</TableCell>
            <Figures totals={row.slice?.totals ?? null} share={row.slice?.share ?? null} />
          </TableRow>
        ))}
      </TableBody>
      {total !== null && (
        <TableFooter>
          <TableRow>
            <TableHead scope="row" className="py-row text-left">
              {tp('wallets.total')}
            </TableHead>
            {/* No asset count: the rows count distinct assets per wallet, and
                one asset split across two wallets is in both, so a column
                total would be a sum that is not the portfolio's count. */}
            <TableCell className="py-row" />
            <Figures totals={total} share={null} whole />
          </TableRow>
        </TableFooter>
      )}
    </Table>
  );
}

/** The portfolio's share of itself, through the same formatter as every row. */
const WHOLE = MoneyValue.fromString('1');

/** Value, cost, result and share — the four columns BR-022-34 names. */
async function Figures({
  totals,
  share,
  whole = false,
}: {
  readonly totals: ReportTotals | null;
  readonly share: MoneyValue | null;
  /** The footer: the portfolio is 100 % of itself by definition. */
  readonly whole?: boolean;
}) {
  const tp = await getTranslations('portfolio');
  const t = await getTranslations('reports');
  const tCommon = await getTranslations('common');

  if (totals === null) {
    // A wallet holding nothing: said once, across the four figures, rather
    // than as four zeros a reader could take for real ones.
    return (
      <TableCell colSpan={4} className="py-row text-right">
        <Text as="span" size="sm" tone="muted">
          {tp('wallets.noHoldings')}
        </Text>
      </TableCell>
    );
  }

  const { result } = unrealizedResult(totals);

  return (
    <>
      <TableCell className="py-row text-right">
        {/* SPEC-009 / BR-011-15 — a wallet holding an accrued CDB is valued,
            not quoted, and says so beside the figure (BR-022-32). */}
        <EstimatedValue value={totals.value} estimated={totals.estimated} justify="end" />
      </TableCell>
      <TableCell className="py-row text-right">
        <Cluster gap="sm" justify="end" align="baseline">
          <Money value={totals.costBasis} />
          {/* SPEC-007 BR-007-06 / DL-007-12 — never hidden. */}
          <CostEstimateMarker
            shown={totals.costEstimated}
            label={tCommon('estimated')}
            title={t('markers.costEstimated.explanation')}
          />
        </Cluster>
      </TableCell>
      <TableCell className="py-row text-right">
        <Money value={result} signed />
      </TableCell>
      <TableCell className="py-row text-right tabular-nums">
        {whole ? (
          <Money value={WHOLE} kind="percent" />
        ) : share === null ? (
          '—'
        ) : (
          <Money value={share} kind="percent" />
        )}
      </TableCell>
    </>
  );
}
