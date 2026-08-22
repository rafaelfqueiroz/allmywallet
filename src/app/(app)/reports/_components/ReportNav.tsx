import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';

/**
 * SPEC-011 — moving between the reports.
 *
 * The four reports share a control bar, so they must also share a way to get
 * from one to another carrying nothing across: each link is a plain route with
 * no query string, which resets period, scope and grouping to that report's
 * own defaults rather than smuggling one report's state into another where the
 * default grouping differs (BR-011-04).
 *
 * Rendered as a `nav` with its own accessible name so it is not confused with
 * the application shell's navigation — two `nav` landmarks on a page are fine;
 * two unnamed ones are not.
 */
export async function ReportNav({ current }: { readonly current: string }) {
  const t = await getTranslations('reports');

  const items = [
    { href: '/reports', label: t('links.overview') },
    { href: '/reports/patrimonio', label: t('links.patrimonio') },
    { href: '/reports/performance', label: t('links.performance') },
    { href: '/reports/composition', label: t('links.composicao') },
    { href: '/reports/earnings', label: t('links.proventos') },
  ] as const;

  return (
    <nav aria-label={t('links.label')}>
      <Cluster gap="sm">
        {items.map((item) => (
          <Button
            key={item.href}
            asChild
            variant={item.href === current ? 'secondary' : 'ghost'}
            size="sm"
          >
            <Link href={item.href} aria-current={item.href === current ? 'page' : undefined}>
              {item.label}
            </Link>
          </Button>
        ))}
      </Cluster>
    </nav>
  );
}
