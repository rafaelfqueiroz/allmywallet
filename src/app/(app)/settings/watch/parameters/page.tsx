import { getTranslations } from 'next-intl/server';
import { WatchSection } from '@/app/(app)/settings/watch/_components/WatchSection';
import { ParameterSection } from '@/app/parameter-form';
import { tryUserId } from '@/lib/session';
import { PageShell } from '@/app/page-shell';
import { SettingsFrame } from '@/app/(app)/settings/_components/SettingsFrame';
import { EmptyState } from '@/components/patterns/empty-state';

/**
 * SPEC-022 BR-022-13 — Configurações › Observar preços › **Parâmetros**: the
 * registry's user-settable keys for watching prices (the opportunity e-mail
 * cooldown, SPEC-018 BR-018-22), rendered by the parameter-form pattern (#207).
 * This is the one page that owns the `settings.watch` surface; a key added to
 * it appears here with no other change.
 */
export const dynamic = 'force-dynamic';

export default async function WatchParametersPage() {
  const t = await getTranslations('watch');
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
    <SettingsFrame>
      <WatchSection>
        <ParameterSection surface="settings.watch" />
      </WatchSection>
    </SettingsFrame>
  );
}
