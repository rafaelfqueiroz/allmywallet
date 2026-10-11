import type { ReactNode } from 'react';
import { Wallet } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { PageShell } from '@/app/page-shell';
import { SubNav } from '@/components/patterns/sub-nav';
import { Split } from '@/components/layout/split';
import { Stack } from '@/components/layout/stack';

/**
 * SPEC-022 BR-022-05/16 — **Configurações**: setup, and never a portfolio
 * figure. One frame for its sections, so they share the heading and the
 * vertical sub-navigation and differ only in their content.
 *
 * - **Only the sections that exist are listed (DS-26).** Importar and Observar
 *   preços join the list in the issues that move them (#211, #212); a menu item
 *   that 404s is worse than a shorter menu.
 * - **A section with more than one task uses tabs inside it** (BR-022-16,
 *   BR-022-15) — Carteiras' are in its own header, one URL each.
 * - Narrow screens stack the sub-navigation above the content rather than
 *   squeezing both (the split is on the container, see `Split`).
 *
 * The page's own signed-out state is each section's, as everywhere in `(app)`.
 */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations('settings');

  return (
    <PageShell title={t('title')} description={t('description')}>
      <Split side="start">
        <SubNav
          label={t('navLabel')}
          items={[
            { href: '/settings/wallets', label: t('sections.wallets'), icon: <Wallet /> },
          ]}
        />
        <Stack gap="lg">{children}</Stack>
      </Split>
    </PageShell>
  );
}
