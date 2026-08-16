import { getTranslations } from 'next-intl/server';
import { EmptyState } from '@/components/patterns/empty-state';

/**
 * SPEC-011 BR-011-16 / AC-14 — the empty state every report shares.
 *
 * **Why it is shared rather than copied.** BR-011-06 makes "same control, same
 * options, same semantics" a rule across all four reports, and an empty state
 * is semantics: a user who learns that an empty wallet says *"Esta carteira
 * ainda está vazia"* on Composition should not meet different wording on
 * Patrimônio. It lived inside `/reports/page.tsx` while there was one report;
 * the second one is the moment that stops being tenable.
 *
 * **It is scoped, and that distinction is the point.** "You have no
 * investments yet" and "this wallet is empty" prompt different next actions —
 * import an extract, versus assign an asset — and a single generic message
 * would send half the readers to the wrong one.
 *
 * Never `R$ 0,00`: a wallet holding nothing and a wallet whose holdings are
 * worth nothing render identically as a zero, and only the second one means
 * "this is what your money is doing".
 */
export async function ReportEmptyState({ scoped }: { readonly scoped: boolean }) {
  const t = await getTranslations('reports');

  return (
    <EmptyState
      title={scoped ? t('empty.walletTitle') : t('empty.portfolioTitle')}
      description={scoped ? t('empty.walletBody') : t('empty.portfolioBody')}
    />
  );
}
