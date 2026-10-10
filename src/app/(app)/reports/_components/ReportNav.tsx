import { getTranslations } from 'next-intl/server';
import { RouteTabs } from '@/components/patterns/route-tabs';

/**
 * SPEC-011 — moving between the reports.
 *
 * The four reports share a control bar, so they must also share a way to get
 * from one to another carrying nothing across: each link is a plain route with
 * no query string, which resets period, scope and grouping to that report's
 * own defaults rather than smuggling one report's state into another where the
 * default grouping differs (BR-011-04). `RouteTabs` carries nothing by default
 * — it has no `preserveParams` here — and that stays true until the scope
 * selector (SPEC-022 BR-022-17) replaces each report's own scope field.
 *
 * SPEC-022 BR-022-15 — rendered as the shared route tabs rather than as a row
 * of buttons, so the reports' tab bar looks like every other one. The overview
 * is matched exactly: `/reports` is the root of the others and would otherwise
 * stay active under all of them.
 *
 * Rendered as a `nav` with its own accessible name so it is not confused with
 * the application shell's navigation — two `nav` landmarks on a page are fine;
 * two unnamed ones are not.
 */
export async function ReportNav() {
  const t = await getTranslations('reports');

  return (
    <RouteTabs
      label={t('links.label')}
      tabs={[
        { href: '/reports', label: t('links.overview'), exact: true },
        { href: '/reports/patrimonio', label: t('links.patrimonio') },
        { href: '/reports/performance', label: t('links.performance') },
        { href: '/reports/composition', label: t('links.composicao') },
        { href: '/reports/earnings', label: t('links.proventos') },
      ]}
    />
  );
}
