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
}

export async function Pagination({ page, pageSize, total, hrefFor }: PaginationProps) {
  const t = await getTranslations('transactions.pagination');
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const hasPrevious = page > 1;
  const hasNext = page < pageCount;

  return (
    <Cluster justify="between" align="center" gap="md" role="navigation" aria-label={t('label')}>
      <Text tone="muted" size="sm">
        {t('summary', { page, pages: pageCount, total })}
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
