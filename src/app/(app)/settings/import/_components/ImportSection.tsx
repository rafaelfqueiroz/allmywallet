import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import {
  IMPORT_HISTORY_PATH,
  IMPORT_PARAMETERS_PATH,
  IMPORT_SEND_PATH,
} from '@/app/(app)/import/paths';
import { SettingsFrame } from '@/app/(app)/settings/_components/SettingsFrame';
import { RouteTabs } from '@/components/patterns/route-tabs';

/**
 * SPEC-022 BR-022-05/15/16, DL-022-12 — Configurações › **Importar**: one
 * section, one task per pill tab, each with its own URL. **Enviar** is the
 * upload beside the B3 export guide; **Histórico** is every batch, paginated;
 * and **Parâmetros** is the `settings.import` registry surface, as Carteiras
 * has it (#210) — a page of its own rather than a third block under the
 * upload, because no page stacks two unrelated tasks (SPEC-022 AC). Written
 * once for the three. No primary action: Enviar is the upload itself.
 *
 * A batch's own page (`[batchId]`) is not a task; it has its way back to
 * Histórico on the pill row.
 */
export async function ImportSection({ children }: { readonly children: ReactNode }) {
  const t = await getTranslations('import');

  return (
    <SettingsFrame
      tasks={
        <RouteTabs
          variant="pill"
          label={t('tabs.label')}
          tabs={[
            { href: IMPORT_SEND_PATH, label: t('tabs.send'), exact: true },
            { href: IMPORT_HISTORY_PATH, label: t('tabs.history') },
            { href: IMPORT_PARAMETERS_PATH, label: t('tabs.parameters') },
          ]}
        />
      }
    >
      {children}
    </SettingsFrame>
  );
}
