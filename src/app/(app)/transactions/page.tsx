import Link from 'next/link';
import { Pencil, Trash2 } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { listTransactions } from '@/core/ledger/list-transactions';
import type { TransactionListItem } from '@/core/ledger/ports';
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
import { BULK_FORM_ID, BulkBar } from '@/app/(app)/transactions/_components/BulkBar';
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
import { ErrorState } from '@/components/patterns/error-state';
import { Money } from '@/app/money';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Text } from '@/components/ui/text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
        <Stack gap="md">
          <LedgerTable
            rows={await Promise.all(result.value.items.map(ledgerRow))}
            total={result.value.total}
            // One set of options, so the table writes what this page parses.
            pageSizeOptions={LEDGER_TABLE_URL_OPTIONS.pageSizeOptions}
            defaultPageSize={LEDGER_TABLE_URL_OPTIONS.defaults.pageSize}
            defaultSort={DEFAULT_SORT}
            toolbar={
              <Controls
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
            }
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

          {/*
            BR-006-17: the selection lives in the DOM. The row checkboxes name
            this form with their `form` attribute, so the browser collects the
            selection natively on submit — no client state that can disagree
            with what is ticked — without the bulk form having to wrap the
            table and, with it, the filter bar's own GET form.
          */}
          {result.value.total > 0 && <BulkBar action={bulkTransactionsAction} wallets={wallets} />}
        </Stack>
      )}
    </PageShell>
  );
}

/**
 * One ledger row, rendered on the server cell by cell (see `LedgerTable` for
 * why the cells arrive finished).
 *
 * BR-006-03: `active` renders plainly; `unclassified` and `superseded` carry a
 * visible badge rather than being hidden or blended in — the row still shows
 * its real figures, but its status is never ambiguous.
 */
async function ledgerRow(item: TransactionListItem): Promise<LedgerRow> {
  const t = await getTranslations('transactions');
  const tCommon = await getTranslations('common');
  const tType = await getTranslations('import.transactionType');
  const tx = item.transaction;

  return {
    id: tx.id,
    cells: {
      select: (
        <Checkbox form={BULK_FORM_ID} name="selected" value={tx.id} aria-label={t('bulk.select')} />
      ),
      tradeDate: <span className="whitespace-nowrap">{formatBusinessDate(tx.tradeDate)}</span>,
      asset: (
        <Stack gap="none">
          <Text as="span" weight="medium">
            {item.assetCode}
          </Text>
          <Text as="span" size="xs" tone="muted">
            {item.assetName}
          </Text>
        </Stack>
      ),
      type: <span className="whitespace-nowrap">{tType(tx.type)}</span>,
      institution: <span className="whitespace-nowrap">{item.institutionName ?? '—'}</span>,
      quantity: <Money value={tx.quantity} kind="quantity" />,
      unitPrice: (
        <Cluster gap="sm" justify="end" align="baseline">
          <Money value={tx.unitPrice} />
          {/* SPEC-007 BR-007-06 / SPEC-005 BR-005-20d — never hidden: this
              is the transaction whose own price is the estimate. */}
          <TransactionCostEstimateMarker
            costIsEstimate={tx.costIsEstimate}
            estimateCloseDate={tx.estimateCloseDate}
            label={tCommon('estimated')}
            closeExplanation={(date) => t('markers.costEstimated.closeExplanation', { date })}
            carriedExplanation={t('markers.costEstimated.carriedExplanation')}
          />
        </Cluster>
      ),
      totalValue: <Money value={tx.totalValue} />,
      status:
        tx.status === 'active' ? (
          <Text as="span" size="sm" tone="muted">
            {t(`status.${tx.status}`)}
          </Text>
        ) : (
          <Badge variant="outline">{t(`status.${tx.status}`)}</Badge>
        ),
      provenance: (
        <Cluster gap="xs" align="center">
          {/* BR-006-02: provenance is visible in the UI, not merely stored —
              and, for an imported row, links back to the batch it came from,
              which is what makes a figure "explainable back to its source". */}
          {tx.importBatchId === null ? (
            <Badge variant="secondary">{t('provenance.manual')}</Badge>
          ) : (
            <Badge variant="secondary" asChild>
              <Link href={importBatchPath(tx.importBatchId)}>{t('provenance.imported')}</Link>
            </Badge>
          )}
          {/* BR-006-16: a human corrected this row since it was imported. */}
          {tx.isUserModified && (
            <Badge variant="outline" title={t('modifiedExplanation')}>
              {t('modified')}
            </Badge>
          )}
        </Cluster>
      ),
      /*
        BR-006-12/13 as links rather than buttons: both lead to a page that
        asks something before it writes — the edit form, and the deletion's
        mandatory disclosure of what will be recalculated. A link also keeps
        them out of the bulk form's submission entirely.
      */
      actions: (
        // Icon buttons, as the prototype's row actions: eleven columns of
        // text actions do not fit the content width. The accessible name is
        // the word, and `title` shows it on hover.
        <Cluster gap="xs" className="flex-nowrap">
          <Button asChild variant="ghost" size="icon-sm">
            <Link
              href={`/transactions/${tx.id}/edit`}
              aria-label={t('edit.action')}
              title={t('edit.action')}
            >
              <Pencil aria-hidden="true" />
            </Link>
          </Button>
          <Button asChild variant="ghost" size="icon-sm">
            <Link
              href={`/transactions/${tx.id}/delete`}
              aria-label={t('delete.action')}
              title={t('delete.action')}
            >
              <Trash2 aria-hidden="true" />
            </Link>
          </Button>
        </Cluster>
      ),
    },
  };
}
