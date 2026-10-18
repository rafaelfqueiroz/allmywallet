import { getTranslations } from 'next-intl/server';
import { ImportSection } from '@/app/(app)/settings/import/_components/ImportSection';
import { ParameterSection } from '@/app/parameter-form';
import { tryUserId } from '@/lib/session';
import { PageShell } from '@/app/page-shell';
import { EmptyState } from '@/components/patterns/empty-state';

/**
 * SPEC-022 BR-022-13 — Configurações › Importar › **Parâmetros**: the
 * registry's user-settable keys for importing (the staleness threshold),
 * rendered by the parameter-form pattern (#207). This is the one page that
 * owns the `settings.import` surface; a key added to it appears here with no
 * other change.
 */
export const dynamic = 'force-dynamic';

export default async function ImportParametersPage() {
  const t = await getTranslations('import');
  const ts = await getTranslations('settings');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell title={ts('title')}>
        <EmptyState title={t('signedOut')} />
      </PageShell>
    );
  }

  return (
    <ImportSection>
      <ParameterSection surface="settings.import" />
    </ImportSection>
  );
}
