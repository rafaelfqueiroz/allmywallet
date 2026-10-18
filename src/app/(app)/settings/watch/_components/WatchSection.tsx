import type { ReactNode } from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { WATCH_NEW_RULE_PATH, WATCH_PARAMETERS_PATH, WATCH_RULES_PATH } from '@/lib/watch-paths';
import { SettingsFrame } from '@/app/(app)/settings/_components/SettingsFrame';
import { RouteTabs } from '@/components/patterns/route-tabs';
import { Button } from '@/components/ui/button';

/**
 * SPEC-022 BR-022-05/15/16 — Configurações › **Observar preços**: one section,
 * one task per pill tab, each with its own URL. **Regras** is SPEC-018's rule
 * screen; **Parâmetros** is the `settings.watch` registry surface (the e-mail
 * cooldown, BR-022-13), a tab of its own as Carteiras and Importar have it
 * (#210, #211) rather than a form under the rules, because no page stacks two
 * unrelated tasks. Written once for both.
 *
 * "Nova regra" is the section's primary action. A rule belongs to a held asset
 * (BR-018-02), so it starts from one: the link lands on the list of assets
 * with no rule yet, each with its own "Criar regra".
 */
export async function WatchSection({ children }: { readonly children: ReactNode }) {
  const t = await getTranslations('watch');

  return (
    <SettingsFrame
      tasks={
        <RouteTabs
          variant="pill"
          label={t('tabs.label')}
          tabs={[
            { href: WATCH_RULES_PATH, label: t('tabs.rules'), exact: true },
            { href: WATCH_PARAMETERS_PATH, label: t('tabs.parameters') },
          ]}
        />
      }
      actions={
        <Button asChild>
          <Link href={WATCH_NEW_RULE_PATH}>
            <Plus aria-hidden />
            {t('newRule')}
          </Link>
        </Button>
      }
    >
      {children}
    </SettingsFrame>
  );
}
