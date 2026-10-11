import type { ReactNode } from 'react';
import { Upload, Wallet } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { PageShell } from '@/app/page-shell';
import { IMPORT_SEND_PATH } from '@/app/(app)/import/paths';
import { SubNav } from '@/components/patterns/sub-nav';
import { Split } from '@/components/layout/split';
import { Stack } from '@/components/layout/stack';

/**
 * SPEC-022 BR-022-05/16 — **Configurações**: setup, and never a portfolio
 * figure. One frame for its sections, so they share the heading and the
 * vertical sub-navigation and differ only in their content.
 *
 * **Rendered by each page, not by a layout** — like `PortfolioFrame`. The shell
 * reports the masking the page was rendered with (`@/app/page-shell`), and a
 * layout is not re-rendered when the user moves between its children, so a
 * masking change made in another tab or on another device would leave the eye
 * contradicting the page. That matters here as soon as a section with amounts
 * (Importar, #211) moves under this frame.
 *
 * - **Only the sections that exist are listed (DS-26).** Importar joined with
 *   #211; Observar preços joins in the issue that moves it (#212).
 * - **A section with more than one task uses tabs inside it** (BR-022-16,
 *   BR-022-15) — Carteiras' are in its own header, one URL each.
 * - Narrow screens stack the sub-navigation above the content rather than
 *   squeezing both (the split is on the container, see `Split`).
 */
export async function SettingsFrame({ children }: { readonly children: ReactNode }) {
  const t = await getTranslations('settings');

  return (
    <PageShell title={t('title')} description={t('description')}>
      <Split side="start">
        <SubNav
          label={t('navLabel')}
          items={[
            { href: '/settings/wallets', label: t('sections.wallets'), icon: <Wallet /> },
            { href: IMPORT_SEND_PATH, label: t('sections.import'), icon: <Upload /> },
          ]}
        />
        <Stack gap="lg">{children}</Stack>
      </Split>
    </PageShell>
  );
}
