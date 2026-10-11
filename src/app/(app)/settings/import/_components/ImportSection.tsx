import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import {
  IMPORT_HISTORY_PATH,
  IMPORT_PARAMETERS_PATH,
  IMPORT_SEND_PATH,
} from '@/app/(app)/import/paths';
import { RouteTabs } from '@/components/patterns/route-tabs';
import { Stack } from '@/components/layout/stack';

/**
 * SPEC-022 BR-022-05/15/16, DL-022-12 — Configurações › **Importar**: one
 * section, one task per tab, each with its own URL. **Enviar** is the upload
 * beside the B3 export guide; **Histórico** is every batch, paginated; and
 * **Parâmetros** is the `settings.import` registry surface, as Carteiras has
 * it (#210) — a page of its own rather than a third block under the upload,
 * because no page stacks two unrelated tasks (SPEC-022 AC). The header is
 * written once for the three.
 *
 * A batch's own page (`[batchId]`) is not a tab and has its own header.
 */
export async function ImportSection({ children }: { readonly children: ReactNode }) {
  const t = await getTranslations('import');

  return (
    <Stack gap="lg">
      <Stack gap="md">
        <h2 className="text-lg font-medium">{t('sectionTitle')}</h2>
        <RouteTabs
          label={t('tabs.label')}
          tabs={[
            { href: IMPORT_SEND_PATH, label: t('tabs.send'), exact: true },
            { href: IMPORT_HISTORY_PATH, label: t('tabs.history') },
            { href: IMPORT_PARAMETERS_PATH, label: t('tabs.parameters') },
          ]}
        />
      </Stack>
      {children}
    </Stack>
  );
}
