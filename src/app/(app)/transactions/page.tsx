import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { listTransactions } from '@/core/ledger/list-transactions';
import type { TransactionListItem } from '@/core/ledger/ports';
import { formatBusinessDate } from '@/i18n/format';
import {
  PAGE_SIZE,
  PARAM,
  fromSearchParams,
  hasActiveFilters,
  paginationFor,
  toQueryString,
} from '@/lib/transactions-url-state';
import { Controls } from '@/app/(app)/transactions/_components/Controls';
import { Pagination } from '@/app/(app)/transactions/_components/Pagination';
import { listAssetOptions, listInstitutionOptions } from '@/app/(app)/transactions/data';
import { withTransactionsDeps } from '@/app/(app)/transactions/composition';
import { tryUserId } from '@/app/(app)/transactions/session';
import { PageShell } from '@/components/patterns/page-shell';
import { EmptyState } from '@/components/patterns/empty-state';
import { ErrorState } from '@/components/patterns/error-state';
import { Money } from '@/components/patterns/money';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Text } from '@/components/ui/text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
 * SPEC-006 BR-006-07/08/09/10/02/03 — the transaction ledger's own surface.
 *
 * The first of two PRs for #9: list, filters, provenance and CSV export.
 * Manual create/edit/delete/bulk assignment are SPEC-006's other business
 * rules (BR-006-11..18) and ship separately — `core/ledger/{delete,
 * bulk-delete}-transaction.ts` exist and are unit-tested but deliberately not
 * wired here (`tests/structural/use-cases-have-callers.test.ts`'s
 * `KNOWN_ORPHANS` still names them against this same issue).
 *
 * Follows `(app)/reports/page.tsx`'s shape: a `data.ts`/`composition.ts` pair
 * (AR-02), one `withTenant` transaction for the whole render (AR-11), and a
 * plain `<form method="get">` control bar with state in the URL (DL-011-06,
 * applied to this surface by `lib/transactions-url-state.ts`).
 *
 * Never statically prerendered — this renders one tenant's own ledger, so a
 * cached copy would be served to everyone (same reasoning as `(app)/reports`
 * and `(app)/wallets`).
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TransactionsPage({ searchParams }: PageProps) {
  const t = await getTranslations('transactions');
  const tErrors = await getTranslations('errors');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell width="wide" title={t('title')}>
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

  const { filter, page } = fromSearchParams(params);
  const pagination = paginationFor(page);

  const { result, assetOptions, institutionOptions } = await withTransactionsDeps(
    userId,
    async (deps, tx) => {
      const [result, assetOptions, institutionOptions] = await Promise.all([
        listTransactions(deps.transactions, filter, pagination),
        listAssetOptions(tx),
        listInstitutionOptions(),
      ]);
      return { result, assetOptions, institutionOptions };
    },
  );

  // BR-006-08: whether any filter narrowed the query, distinguishing "your
  // ledger is empty" from "nothing matches these filters" — the same
  // distinction `(app)/reports/page.tsx`'s ReportEmptyState makes for a
  // period versus a whole portfolio.
  const filtered = hasActiveFilters(filter);

  // BR-006-10: the CSV export honours the *active* filters and nothing else —
  // built from the same query-string parameters the page itself was loaded
  // with, with `page` dropped so the export is never accidentally scoped to
  // one page of results.
  const exportHref = `/api/transactions/export${toQueryString(params)}`;

  return (
    <PageShell
      width="wide"
      title={t('title')}
      description={t('description')}
      actions={
        <Button asChild variant="outline">
          <a href={exportHref}>{t('export.csv')}</a>
        </Button>
      }
    >
      <Controls
        from={params.get(PARAM.from) ?? ''}
        to={params.get(PARAM.to) ?? ''}
        asset={params.get(PARAM.asset) ?? ''}
        assetClass={params.get(PARAM.assetClass) ?? ''}
        type={params.get(PARAM.type) ?? ''}
        institution={params.get(PARAM.institution) ?? ''}
        status={params.get(PARAM.status) ?? ''}
        search={params.get(PARAM.q) ?? ''}
        assetOptions={assetOptions}
        institutionOptions={institutionOptions}
      />

      {!result.ok ? (
        // AR-37/AR-38: the use case returns a stable code, not a formatted
        // string — this is the errors.* catalogue's first real consumer
        // (`INVALID_PAGINATION` is the only code `listTransactions` can
        // actually produce here, since `paginationFor` always builds a valid
        // limit/offset — this branch exists for defence, not the common case).
        <ErrorState title={tErrors(result.error.code)} />
      ) : result.value.total === 0 ? (
        <EmptyState
          title={filtered ? t('empty.filteredTitle') : t('empty.ledgerTitle')}
          description={filtered ? t('empty.filteredBody') : t('empty.ledgerBody')}
        />
      ) : (
        <Stack gap="md">
          <Table>
            <TableCaption className="sr-only">{t('table.caption')}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t('table.date')}</TableHead>
                <TableHead scope="col">{t('table.asset')}</TableHead>
                <TableHead scope="col">{t('table.type')}</TableHead>
                <TableHead scope="col">{t('table.institution')}</TableHead>
                <TableHead scope="col" className="text-right">
                  {t('table.quantity')}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {t('table.unitPrice')}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {t('table.total')}
                </TableHead>
                <TableHead scope="col">{t('table.status')}</TableHead>
                <TableHead scope="col">{t('table.provenance')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.value.items.map((item) => (
                <TransactionRow key={item.transaction.id} item={item} />
              ))}
            </TableBody>
          </Table>

          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={result.value.total}
            hrefFor={(target) => `/transactions${toQueryString(params, target)}`}
          />
        </Stack>
      )}
    </PageShell>
  );
}

/**
 * BR-006-03: `active` renders plainly; `unclassified` and `superseded` carry a
 * visible badge rather than being hidden or blended in — the row still shows
 * its real figures, but its status is never ambiguous.
 */
async function TransactionRow({ item }: { readonly item: TransactionListItem }) {
  const t = await getTranslations('transactions');
  const tType = await getTranslations('import.transactionType');
  const tx = item.transaction;

  return (
    <TableRow>
      <TableCell className="py-row whitespace-nowrap">{formatBusinessDate(tx.tradeDate)}</TableCell>
      <TableCell className="py-row">
        <Stack gap="none">
          <Text as="span" weight="medium">
            {item.assetCode}
          </Text>
          <Text as="span" size="xs" tone="muted">
            {item.assetName}
          </Text>
        </Stack>
      </TableCell>
      <TableCell className="py-row whitespace-nowrap">{tType(tx.type)}</TableCell>
      <TableCell className="py-row whitespace-nowrap">{item.institutionName ?? '—'}</TableCell>
      <TableCell className="py-row text-right">
        <Money value={tx.quantity} kind="quantity" />
      </TableCell>
      <TableCell className="py-row text-right">
        <Money value={tx.unitPrice} />
      </TableCell>
      <TableCell className="py-row text-right">
        <Money value={tx.totalValue} />
      </TableCell>
      <TableCell className="py-row whitespace-nowrap">
        {tx.status === 'active' ? (
          <Text as="span" size="sm" tone="muted">
            {t(`status.${tx.status}`)}
          </Text>
        ) : (
          <Badge variant="outline">{t(`status.${tx.status}`)}</Badge>
        )}
      </TableCell>
      <TableCell className="py-row whitespace-nowrap">
        <Cluster gap="xs" align="center">
          {/* BR-006-02: provenance is visible in the UI, not merely stored —
              and, for an imported row, links back to the batch it came from,
              which is what makes a figure "explainable back to its source". */}
          {tx.importBatchId === null ? (
            <Badge variant="secondary">{t('provenance.manual')}</Badge>
          ) : (
            <Badge variant="secondary" asChild>
              <Link href={`/import/${tx.importBatchId}`}>{t('provenance.imported')}</Link>
            </Badge>
          )}
          {/* BR-006-16: a human corrected this row since it was imported. */}
          {tx.isUserModified && (
            <Badge variant="outline" title={t('modifiedExplanation')}>
              {t('modified')}
            </Badge>
          )}
        </Cluster>
      </TableCell>
    </TableRow>
  );
}
