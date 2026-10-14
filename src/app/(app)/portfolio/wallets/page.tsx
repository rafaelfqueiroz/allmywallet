import type { ReactNode } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { ReportQueryResult } from '@/core/reporting/base-query';
import { UNASSIGNED_GROUP_ID, type ReportTotals } from '@/core/reporting/ports';
import type { CompositionReport, CompositionSlice } from '@/core/reporting/composition/ports';
import { unrealizedResult } from '@/core/reporting/composition/result';
import { Money as MoneyValue, type Quantity } from '@/core/shared/money';
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
import { Text } from '@/components/ui/text';
import { NodeTable, type NodeColumn, type NodeRow } from '@/components/patterns/node-table';
import { ranksOf, rankKeys } from '@/lib/rank-keys';

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
          // SPEC-022 BR-022-36 — the selected wallet's row, in a panel.
          <Section title={row.name}>
            <ComparisonTable rows={[row]} total={null} paginated={false} />
          </Section>
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
          <UnassignedTable
            holdings={unassigned}
            names={unassigned.map((holding) => {
              const label = labelFor(labels, holding.assetId);
              return `${label.code} — ${label.name}`;
            })}
          />
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

/**
 * SPEC-022 BR-022-18 — the comparison as a `DataTable`: it grows with the
 * wallets, so it pages, filters by wallet name and sorts by every column.
 * Every cell is rendered here, on the server, through `Money` (masking,
 * BR-022-24, and no money crossing as a number); the sort keys are names,
 * counts and **ranks** from exact `Money.comparedTo` (`ranksOf`).
 *
 * The total (BR-022-34, BR-011-08) is the table's pinned footer, so it stays
 * under the last row on every page. `paginated={false}` is the one-wallet view:
 * one row, bounded by construction, which needs no pager.
 */
async function ComparisonTable({
  rows,
  total,
  paginated = true,
}: {
  readonly rows: readonly ComparisonRow[];
  readonly total: ReportTotals | null;
  readonly paginated?: boolean;
}) {
  const tp = await getTranslations('portfolio');
  const t = await getTranslations('reports');
  const tCommon = await getTranslations('common');

  const value = ranksOf(rows, (row) => row.slice?.totals.value ?? null);
  const cost = ranksOf(rows, (row) => row.slice?.totals.costBasis ?? null);
  const result = ranksOf(rows, (row) =>
    row.slice === null ? null : unrealizedResult(row.slice.totals).result,
  );
  const share = ranksOf(rows, (row) => row.slice?.share ?? null);

  const columns: NodeColumn[] = [
    {
      id: 'wallet',
      header: tp('wallets.columnWallet'),
      kind: 'text',
      // SPEC-022 BR-022-41: three amounts at their full width leave the name
      // 18ch at 1280 px (#245); a longer name truncates, in full on demand.
      width: 18,
      sortable: paginated,
    },
    {
      id: 'assets',
      header: tp('wallets.columnAssets'),
      kind: 'number',
      width: 9,
      sortable: paginated,
    },
    { id: 'value', header: tp('wallets.columnValue'), kind: 'money', sortable: paginated },
    { id: 'cost', header: tp('wallets.columnCost'), kind: 'money', sortable: paginated },
    { id: 'result', header: tp('wallets.columnResult'), kind: 'money', sortable: paginated },
    { id: 'share', header: tp('wallets.columnShare'), kind: 'percent', sortable: paginated },
  ];

  const nodes: NodeRow[] = rows.map((row, index) => {
    const label = row.synthetic ? tp('wallets.unassignedTitle') : row.name;
    const totals = row.slice?.totals ?? null;
    const dash = <span aria-hidden="true">—</span>;
    return {
      id: row.walletId,
      keys: {
        wallet: label,
        assets: row.assets,
        ...rankKeys({ value, cost, result, share }, index),
      },
      cells: {
        wallet: row.synthetic ? (
          <span className="font-medium">{label}</span>
        ) : (
          <Link
            href={`/portfolio/wallets?wallet=${row.walletId}`}
            className="font-medium underline-offset-4 hover:underline"
          >
            {row.name}
          </Link>
        ),
        assets: row.assets,
        // A wallet holding nothing: said once, in the first figure's cell,
        // rather than as four zeros a reader could take for real ones.
        value:
          totals === null ? (
            <Text as="span" size="sm" tone="muted" className="whitespace-normal">
              {tp('wallets.noHoldings')}
            </Text>
          ) : (
            // SPEC-009 / BR-011-15 — a wallet holding an accrued CDB is valued,
            // not quoted, and says so beside the figure (BR-022-32).
            <EstimatedValue value={totals.value} estimated={totals.estimated} justify="end" />
          ),
        cost:
          totals === null ? (
            dash
          ) : (
            <Cluster gap="sm" justify="end" align="baseline">
              <Money value={totals.costBasis} />
              {/* SPEC-007 BR-007-06 / DL-007-12 — never hidden. */}
              <CostEstimateMarker
                shown={totals.costEstimated}
                label={tCommon('estimated')}
                title={t('markers.costEstimated.explanation')}
              />
            </Cluster>
          ),
        result: totals === null ? dash : <Money value={unrealizedResult(totals).result} signed />,
        share:
          row.slice?.share === null || row.slice?.share === undefined ? (
            dash
          ) : (
            <Money value={row.slice.share} kind="percent" />
          ),
      },
    };
  });

  return (
    <NodeTable
      columns={columns}
      rows={nodes}
      caption={tp('wallets.comparisonTitle')}
      noun={tp('wallets.noun')}
      paramPrefix="wallets"
      sort={{ id: 'value', desc: true }}
      pagination={paginated}
      {...(paginated ? { filterPlaceholder: tp('wallets.filterPlaceholder') } : {})}
      {...(total === null ? {} : { totals: comparisonTotals(total, tp, t, tCommon) })}
    />
  );
}

/** The portfolio's share of itself, through the same formatter as every row. */
const WHOLE = MoneyValue.fromString('1');

type Translate = Awaited<ReturnType<typeof getTranslations>>;

/**
 * Value, cost, result and share of the whole portfolio — the four columns
 * BR-022-34 names. No asset count: the rows count distinct assets per wallet,
 * and one asset split across two wallets is in both, so a column total would
 * be a sum that is not the portfolio's count.
 */
function comparisonTotals(total: ReportTotals, tp: Translate, t: Translate, tCommon: Translate) {
  const { result } = unrealizedResult(total);
  return {
    label: tp('wallets.total'),
    cells: {
      value: <EstimatedValue value={total.value} estimated={total.estimated} justify="end" />,
      cost: (
        <Cluster gap="sm" justify="end" align="baseline">
          <Money value={total.costBasis} />
          <CostEstimateMarker
            shown={total.costEstimated}
            label={tCommon('estimated')}
            title={t('markers.costEstimated.explanation')}
          />
        </Cluster>
      ),
      result: <Money value={result} signed />,
      share: <Money value={WHOLE} kind="percent" />,
    },
  };
}

/**
 * SPEC-022 BR-022-18 — what no wallet has claimed, one asset per row. It grows
 * with the portfolio, so it pages and filters by asset like every list.
 */
async function UnassignedTable({
  holdings,
  names,
}: {
  readonly holdings: readonly { readonly assetId: string; readonly quantity: Quantity }[];
  /** Each holding's "CODE — Name", in the same order. */
  readonly names: readonly string[];
}) {
  const tp = await getTranslations('portfolio');
  const quantity = ranksOf(holdings, (holding) => holding.quantity);

  const rows: NodeRow[] = holdings.map((holding, index) => {
    const rank = quantity[index];
    return {
      id: holding.assetId,
      keys: { asset: names[index] ?? '', ...(rank === undefined ? {} : { quantity: rank }) },
      cells: {
        asset: names[index],
        quantity: <Money value={holding.quantity} kind="quantity" />,
      },
    };
  });

  return (
    <NodeTable
      columns={[
        {
          id: 'asset',
          header: tp('wallets.unassignedColumnAsset'),
          kind: 'text',
          width: 40,
          sortable: true,
        },
        {
          id: 'quantity',
          header: tp('wallets.unassignedColumnQuantity'),
          kind: 'number',
          sortable: true,
        },
      ]}
      rows={rows}
      caption={tp('wallets.unassignedTitle')}
      noun={tp('wallets.unassignedNoun')}
      filterPlaceholder={tp('wallets.unassignedFilterPlaceholder')}
      paramPrefix="unassigned"
      sort={{ id: 'asset', desc: false }}
    />
  );
}
