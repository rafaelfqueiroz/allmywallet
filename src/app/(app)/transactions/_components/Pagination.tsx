import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Cluster } from '@/components/layout/cluster';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';

/**
 * SPEC-006 BR-006-07 — "a chronological, paginated list", over 10.000+ rows.
 *
 * Plain `<a>` links (via `next/link`), not client-side state: the page is
 * already server-rendered from the URL (`lib/transactions-url-state.ts`), so
 * paging is just another link to the same route with `page` changed — no
 * JavaScript required, and the browser's own back button and reload behave
 * correctly for free.
 *
 * The boundary buttons render as real, native-`disabled` buttons rather than
 * being omitted: a control that silently disappears at the first and last
 * page reads, to a screen-reader user tabbing through, as if the page lost a
 * button rather than as "you are at the edge" (WCAG 2.1 4.1.2). A disabled
 * `<button>` is also what keeps it out of tab order correctly, which a live
 * link styled to *look* disabled would not.
 */
export interface PaginationProps {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  /** Builds the href for a given 1-based page, carrying the active filters. */
  readonly hrefFor: (page: number) => string;
  /**
   * The navigation's accessible name, when a page has more than one paged
   * table (a batch's page, #211): two landmarks with one name cannot be told
   * apart. Translated text.
   */
  readonly label?: string;
  /** The summary line, when the rows are not transactions. Translated text. */
  readonly summaryFor?: (counts: {
    readonly page: number;
    readonly pages: number;
    readonly total: number;
  }) => string;
}

export async function Pagination({
  page,
  pageSize,
  total,
  hrefFor,
  label,
  summaryFor,
}: PaginationProps) {
  const t = await getTranslations('transactions.pagination');
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const hasPrevious = page > 1;
  const hasNext = page < pageCount;

  return (
    <Cluster
      justify="between"
      align="center"
      gap="md"
      role="navigation"
      aria-label={label ?? t('label')}
    >
      <Text tone="muted" size="sm">
        {summaryFor
          ? summaryFor({ page, pages: pageCount, total })
          : t('summary', { page, pages: pageCount, total })}
      </Text>
      <Cluster gap="sm">
        {hasPrevious ? (
          <Button asChild variant="outline" size="sm">
            <Link href={hrefFor(page - 1)}>{t('previous')}</Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            {t('previous')}
          </Button>
        )}
        {hasNext ? (
          <Button asChild variant="outline" size="sm">
            <Link href={hrefFor(page + 1)}>{t('next')}</Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            {t('next')}
          </Button>
        )}
      </Cluster>
    </Cluster>
  );
}
