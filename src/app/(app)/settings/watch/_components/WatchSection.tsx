import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { WATCH_PARAMETERS_PATH, WATCH_RULES_PATH } from '@/lib/watch-paths';
import { RouteTabs } from '@/components/patterns/route-tabs';
import { Stack } from '@/components/layout/stack';

/**
 * SPEC-022 BR-022-05/15/16 — Configurações › **Observar preços**: one section,
 * one task per tab, each with its own URL. **Regras** is SPEC-018's rule screen;
 * **Parâmetros** is the `settings.watch` registry surface (the e-mail cooldown,
 * BR-022-13), a tab of its own as Carteiras and Importar have it (#210, #211)
 * rather than a form under the rules, because no page stacks two unrelated
 * tasks. The header is written once for both.
 */
export async function WatchSection({ children }: { readonly children: ReactNode }) {
  const t = await getTranslations('watch');

  return (
    <Stack gap="lg">
      <Stack gap="md">
        <h2 className="text-lg font-medium">{t('title')}</h2>
        <RouteTabs
          label={t('tabs.label')}
          tabs={[
            { href: WATCH_RULES_PATH, label: t('tabs.rules'), exact: true },
            { href: WATCH_PARAMETERS_PATH, label: t('tabs.parameters') },
          ]}
        />
      </Stack>
      {children}
    </Stack>
  );
}
