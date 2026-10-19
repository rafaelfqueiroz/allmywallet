import Link from 'next/link';
import { ExternalLink, Pencil, Trash2 } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { listTransactions } from '@/core/ledger/list-transactions';
import type { TransactionListItem } from '@/core/ledger/ports';
import { FIXED_INCOME_CLASSES } from '@/core/valuation/holdings';
import { formatBusinessDate } from '@/i18n/format';
import {
  LEDGER_TABLE_URL_OPTIONS,
  PARAM,
  fromSearchParams,
  hasActiveFilters,
  lastPage,
  ledgerViewFrom,
  paginationFor,
  toQueryString,
} from '@/lib/transactions-url-state';
import { tableParamNames } from '@/lib/table-url-state';
import { bulkTransactionsAction } from '@/app/(app)/transactions/actions';
import { BulkBar } from '@/app/(app)/transactions/_components/BulkBar';
import { RowSelect } from '@/app/(app)/transactions/_components/LedgerSelection';
import { Controls } from '@/app/(app)/transactions/_components/Controls';
import { LedgerTable, type LedgerRow } from '@/app/(app)/transactions/_components/LedgerTable';
import { TransactionCostEstimateMarker } from '@/app/(app)/transactions/_components/TransactionCostEstimateMarker';
import {
  listAssetOptions,
  listInstitutionOptions,
  listWalletChoices,
} from '@/app/(app)/transactions/data';
import { withTransactionsDeps } from '@/app/(app)/transactions/composition';
import { tryUserId } from '@/lib/session';
import { PageShell } from '@/app/page-shell';
import { EmptyState } from '@/components/patterns/empty-state';
import { Section } from '@/components/patterns/section';
import { ErrorState } from '@/components/patterns/error-state';
import { Money } from '@/app/money';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Text } from '@/components/ui/text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { CellLabel } from '@/components/patterns/cell-label';
import { RowMenu } from '@/components/patterns/row-menu';
import { importBatchPath } from '@/app/(app)/import/paths';

/**
 * SPEC-006 BR-006-07/08/09/10/02/03 — the transaction ledger's own surface.
 *
 * The list itself, and the entry point to everything that writes to it:
 * `/transactions/new` (BR-006-11), `/transactions/[id]/edit` (BR-006-12),
 * `/transactions/[id]/delete` (BR-006-13) and the bulk operations
 * (BR-006-17), which are a form wrapping this table rather than a separate
 * screen — see `_components/BulkBar.tsx`.
 *
 * Follows `(app)/reports/page.tsx`'s shape: a `data.ts`/`composition.ts` pair
 * (AR-02), one `withTenant` transaction for the whole render (AR-11), and a
 * plain `<form method="get">` filter bar with state in the URL (DL-011-06,
 * applied to this surface by `lib/transactions-url-state.ts`).
 *
 * SPEC-022 BR-022-04/18: the ledger is its own destination and renders as a
 * `DataTable` (`LedgerTable`), sorted and paged **by the query** — the table
 * shows one page of a ledger that can run to 10.000+ rows (BR-006-07). Sort,
 * page and page size are the table's URL parameters, read here with
 * `ledgerViewFrom`; the filters are SPEC-006's own, in the table's toolbar.
 *
 * Never statically prerendered — this renders one tenant's own ledger, so a
 * cached copy would be served to everyone (same reasoning as `(app)/reports`
 * and `(app)/wallets`).
 */
export const dynamic = 'force-dynamic';

const DEFAULT_SORT = LEDGER_TABLE_URL_OPTIONS.defaults.sort ?? { id: 'tradeDate', desc: true };

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TransactionsPage({ searchParams }: PageProps) {
  const t = await getTranslations('transactions');
  const tErrors = await getTranslations('errors');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell title={t('title')}>
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

  const { filter } = fromSearchParams(params);
  const view = ledgerViewFrom(params);

  const { result, assetOptions, institutionOptions, wallets } = await withTransactionsDeps(
    userId,
    async (deps, tx) => {
      const list = (page: number) =>
        listTransactions(deps.transactions, filter, paginationFor(page, view.pageSize), view.sort);
      const [first, assetOptions, institutionOptions, wallets] = await Promise.all([
        list(view.page),
        listAssetOptions(tx),
        listInstitutionOptions(),
        listWalletChoices(tx),
      ]);
      // A shared link can carry a page the ledger has since shrunk below (a
      // bulk delete, a narrower filter). Serve the last page that exists, the
      // same clamp `DataTable` applies to the page number it shows.
      const last = first.ok ? lastPage(first.value.total, view.pageSize) : 1;
      const result = first.ok && view.page > last ? await list(last) : first;
      return { result, assetOptions, institutionOptions, wallets };
    },
  );

  // BR-006-08: whether any filter narrowed the query, distinguishing "your
  // ledger is empty" from "nothing matches these filters" — the same
  // distinction `(app)/reports/page.tsx`'s ReportEmptyState makes for a
  // period versus a whole portfolio.
  const filtered = hasActiveFilters(filter);

  // BR-006-10: the CSV export honours the *active* filters and nothing else —
  // built from the same query-string parameters the page itself was loaded
  // with, with the table's sort and page dropped so the export is never
  // accidentally scoped to one page of results.
  const exportHref = `/api/transactions/export${toQueryString(params)}`;

  // The table's own parameters, which the filter bar carries through a filter
  // change and its "Limpar filtros" keeps.
  const names = tableParamNames(undefined);
  const sort = params.get(names.sort) ?? '';
  const size = params.get(names.size) ?? '';
  const kept = new URLSearchParams();
  if (sort !== '') kept.set(names.sort, sort);
  if (size !== '') kept.set(names.size, size);
  const clearHref = kept.size === 0 ? '/transactions' : `/transactions?${kept.toString()}`;

  return (
    <PageShell
      title={t('title')}
      description={t('description')}
      actions={
        <Cluster gap="sm">
          <Button asChild variant="outline">
            <a href={exportHref}>{t('export.csv')}</a>
          </Button>
          <Button asChild variant="outline">
            <Link href="/transactions/conversions/new">{t('newConversion')}</Link>
          </Button>
          {/* BR-006-11 — the only way a CDB that no extract carries gets in. */}
          <Button asChild>
            <Link href="/transactions/new">{t('new')}</Link>
          </Button>
        </Cluster>
      }
    >
      {!result.ok ? (
        // AR-37/AR-38: the use case returns a stable code, not a formatted
        // string. `INVALID_PAGINATION` is the only code `listTransactions` can
        // produce, and `ledgerViewFrom` only offers sizes under its ceiling —
        // this branch exists for defence, not the common case.
        <ErrorState title={tErrors(result.error.code)} />
      ) : (
        <Section title={t('table.title', { count: result.value.total })}>
          {/*
            BR-006-17: the selection lives in the DOM. The row checkboxes name
            this form with their `form` attribute, so the browser collects the
            selection natively on submit — no client state that can disagree
            with what is ticked — without the bulk form having to wrap the
            table and, with it, the filter bar's own GET form.
            SPEC-022 BR-022-36 / frame 14 — the selection band sits at the top of
            the panel, above the table, leaving the footer to pagination (#237).
          */}
          <Controls
            /*
                  Keyed on the applied filters (PR #234 review P2): a client
                  navigation — "Limpar filtros", a sort link — keeps this
                  uncontrolled form mounted, and a changed `defaultValue`
                  does not move a mounted select. Without the key, clearing
                  `type=buy` left Tipo showing Compra, and Aplicar put it back.
                */
            key={`${toQueryString(params)}|${sort}|${size}`}
            from={params.get(PARAM.from) ?? ''}
            to={params.get(PARAM.to) ?? ''}
            asset={params.get(PARAM.asset) ?? ''}
            assetClass={params.get(PARAM.assetClass) ?? ''}
            type={params.get(PARAM.type) ?? ''}
            institution={params.get(PARAM.institution) ?? ''}
            status={params.get(PARAM.status) ?? ''}
            wallet={params.get(PARAM.wallet) ?? ''}
            search={params.get(PARAM.q) ?? ''}
            sort={sort}
            size={size}
            clearHref={filtered ? clearHref : undefined}
            assetOptions={assetOptions}
            institutionOptions={institutionOptions}
            walletOptions={wallets}
          />
          {result.value.total > 0 && <BulkBar action={bulkTransactionsAction} wallets={wallets} />}
          <LedgerTable
            rows={await Promise.all(result.value.items.map(ledgerRow))}
            total={result.value.total}
            // One set of options, so the table writes what this page parses.
            pageSizeOptions={LEDGER_TABLE_URL_OPTIONS.pageSizeOptions}
            defaultPageSize={LEDGER_TABLE_URL_OPTIONS.defaults.pageSize}
            defaultSort={DEFAULT_SORT}
            toolbar={null}
            {...(filtered
              ? {}
              : {
                  empty: (
                    <EmptyState
                      title={t('empty.ledgerTitle')}
                      description={t('empty.ledgerBody')}
                    />
                  ),
                })}
            noResults={
              <EmptyState
                title={t('empty.filteredTitle')}
                description={t('empty.filteredBody')}
                action={
                  <Button asChild variant="outline" size="sm">
                    <Link href={clearHref}>{t('filters.clear')}</Link>
                  </Button>
                }
              />
            }
          />
        </Section>
      )}
    </PageShell>
  );
}

/** SPEC-022 BR-022-31 — each ledger status as a status badge, in the frame's colours. */
const STATUS_VARIANT = {
  active: 'success',
  unclassified: 'warning',
  superseded: 'neutral',
} as const satisfies Record<TransactionListItem['transaction']['status'], string>;

/**
 * One ledger row, rendered on the server cell by cell (see `LedgerTable` for
 * why the cells arrive finished).
 *
 * BR-006-03: every status carries a visible badge, `unclassified` and
 * `superseded` in colours of their own rather than hidden or blended in — the
 * row still shows its real figures, but its status is never ambiguous.
 */
async function ledgerRow(item: TransactionListItem): Promise<LedgerRow> {
  const t = await getTranslations('transactions');
  const tType = await getTranslations('import.transactionType');
  const tx = item.transaction;

  return {
    id: tx.id,
    cells: {
      // One selection across the table and the card copy (PR #234 review P1).
      select: <RowSelect id={tx.id} label={t('bulk.select')} />,
      tradeDate: <span className="whitespace-nowrap">{formatBusinessDate(tx.tradeDate)}</span>,
      // BR-022-40: the broker sits under the asset, each line ending in its own
      // ellipsis; the full text opens from the cell (BR-022-18). A CDB, LCI or
      // LCA leads with its name: its code is B3's opaque `Código` (#242 Decision log).
      asset: (
        <CellLabel detail={item.institutionName ?? '—'}>
          {(FIXED_INCOME_CLASSES as ReadonlySet<string>).has(item.assetClass)
            ? item.assetName
            : item.assetCode}
        </CellLabel>
      ),
      // No `whitespace-nowrap`: the table cell is already one line and truncates
      // (BR-022-18), and in the card a long name has to be able to wrap.
      type: <span>{tType(tx.type)}</span>,
      quantity: <Money value={tx.quantity} kind="quantity" />,
      unitPrice: (
        // BR-022-40: the marker sits under the price it qualifies.
        <Stack gap="xs" align="end">
          <Money value={tx.unitPrice} />
          {/* SPEC-007 BR-007-06 / SPEC-005 BR-005-20d — never hidden: this
              is the transaction whose own price is the estimate. */}
          <TransactionCostEstimateMarker
            costIsEstimate={tx.costIsEstimate}
            estimateCloseDate={tx.estimateCloseDate}
            closeExplanation={(date) => t('markers.costEstimated.closeExplanation', { date })}
            carriedExplanation={t('markers.costEstimated.carriedExplanation')}
          />
        </Stack>
      ),
      totalValue: <Money value={tx.totalValue} />,
      // BR-022-40: status and origin share one cell, the origin under the badge.
      status: (
        <Stack gap="xs" align="start" className="min-w-0">
          <Badge dot variant={STATUS_VARIANT[tx.status]}>
            {t(`status.${tx.status}`)}
          </Badge>
          {/* BR-006-02: provenance is visible in the UI, not merely stored. The
              link back to the batch is the row menu's "Ver importação de origem". */}
          <Text as="span" size="xs" tone="muted" data-cell-line>
            {t(tx.importBatchId === null ? 'provenance.manual' : 'provenance.imported')}
          </Text>
          {/* BR-006-16: a human corrected this row. A line of its own: beside the
              origin it would be the part the column cuts. */}
          {tx.isUserModified && (
            <Text as="span" size="xs" tone="muted" data-cell-line title={t('modifiedExplanation')}>
              {t('modified')}
            </Text>
          )}
        </Stack>
      ),
      /*
        BR-006-12/13 as links rather than buttons: both lead to a page that
        asks something before it writes — the edit form, and the deletion's
        mandatory disclosure of what will be recalculated, which Excluir still
        goes through. A link also keeps them out of the bulk form's submission.
        BR-022-40: behind one "⋯" button, so three actions take one control's
        width.
      */
      actions: (
        <RowMenu
          label={t('table.actionsFor', {
            asset: item.assetCode,
            date: formatBusinessDate(tx.tradeDate),
          })}
        >
          <DropdownMenuItem asChild>
            <Link href={`/transactions/${tx.id}/edit`}>
              <Pencil aria-hidden="true" />
              {t('edit.action')}
            </Link>
          </DropdownMenuItem>
          {tx.importBatchId !== null && (
            <DropdownMenuItem asChild>
              <Link href={importBatchPath(tx.importBatchId)}>
                <ExternalLink aria-hidden="true" />
                {t('table.viewImport')}
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild variant="destructive">
            <Link href={`/transactions/${tx.id}/delete`}>
              <Trash2 aria-hidden="true" />
              {t('delete.action')}
            </Link>
          </DropdownMenuItem>
        </RowMenu>
      ),
    },
  };
}
