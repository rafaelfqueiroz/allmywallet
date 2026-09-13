import { getTranslations } from 'next-intl/server';
import {
  ExtractDiagram,
  type ExtractDiagramLabels,
  type ExtractDiagramTab,
} from '@/components/onboarding/extract-diagram';
import { GuideStamp } from '@/components/onboarding/guide-stamp';
import { Stack } from '@/components/layout/stack';
import { List, ListItem } from '@/components/layout/list';
import { Note } from '@/components/patterns/note';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/**
 * SPEC-020 — the export guide's body: how to export Movimentação, Negociação
 * and Posição from investidor.b3.com.br (BR-020-20), which date range to ask
 * for (BR-020-21), and that only these three files are accepted (BR-020-26).
 *
 * **One guide, two surfaces.** `/import` (`ExportGuide.tsx`) and `/onboarding`
 * both need this exact content, and DL-020-01's whole argument against a
 * second copy of anything SPEC-020 does not own applies just as much to a copy
 * SPEC-020 *does* own — two guides drift, and the second one to be edited
 * becomes the wrong one. This component is the one copy; each surface supplies
 * its own heading and lead sentence around it.
 *
 * **BR-020-31 / AC-20 — the diagram is decorative, this list is not.** Each
 * `ExtractDiagram` is `aria-hidden`; the `<ol>` below states the same steps in
 * words, in order, so that with every `<svg>` hidden the instructions survive
 * intact. `tests/e2e/onboarding.spec.ts` verifies exactly that by hiding every
 * `svg` in the guide and reading the list.
 *
 * This is the one place in the guide that still calls `getTranslations`
 * itself — `ExtractDiagram` and `GuideStamp` are plain, prop-driven
 * components (DS-02) so they can be rendered and asserted on directly in a
 * component test; this file does the one translation call and hands each of
 * them the strings it needs.
 */

type ExtractStep = 'movimentacao' | 'negociacao' | 'posicao';

const EXTRACT_STEPS: readonly ExtractStep[] = ['movimentacao', 'negociacao', 'posicao'];

const EXTRATOS_TABS = ['movimentacao', 'negociacao', 'eventos', 'ofertas'] as const;
const INVESTIMENTOS_TABS = ['posicao', 'garantias'] as const;

const B3_PORTAL_URL = 'https://investidor.b3.com.br';

/**
 * BR-020-20 — the two structural shapes: Movimentação and Negociação are tabs
 * under Extratos; Posição is under Minha carteira → Investimentos.
 */
function diagramLabelsFor(
  step: ExtractStep,
  t: Awaited<ReturnType<typeof getTranslations>>,
): ExtractDiagramLabels {
  const inExtratos = step === 'movimentacao' || step === 'negociacao';
  const tabKeys: readonly string[] = inExtratos ? EXTRATOS_TABS : INVESTIMENTOS_TABS;
  const groupLabel = inExtratos ? t('extratos.groupLabel') : t('investimentos.groupLabel');
  const tabs: readonly ExtractDiagramTab[] = tabKeys.map((key) => ({
    key,
    label: inExtratos ? t(`extratos.tabs.${key}`) : t(`investimentos.tabs.${key}`),
  }));

  return {
    groupLabel,
    tabs,
    activeTabIndex: tabKeys.indexOf(step),
    filtrar: t('filtrar'),
    baixar: t('baixar'),
  };
}

export async function ExportGuideContent() {
  const t = await getTranslations('onboarding.guide');
  const tDiagram = await getTranslations('onboarding.diagram');

  return (
    <Stack gap="md">
      <List gap="lg" as="ol">
        {EXTRACT_STEPS.map((step, index) => (
          <ListItem key={step} separated>
            <Stack gap="sm">
              <Text weight="medium">{t(`steps.${step}.title`, { number: index + 1 })}</Text>
              <Text size="sm" tone="muted">
                {t(`steps.${step}.path`)}
              </Text>
              <Text size="sm">{t(`steps.${step}.why`)}</Text>
              <ExtractDiagram labels={diagramLabelsFor(step, tDiagram)} />
            </Stack>
          </ListItem>
        ))}
      </List>

      {/* BR-020-21 — the one instruction that cannot be corrected by a later import. */}
      <Note>{t('earliestDate')}</Note>

      <Text size="sm" tone="muted">
        {t('anyOrder')}
      </Text>

      {/* BR-020-26 — the sourcing strategy's own limit, stated rather than implied. */}
      <Text size="sm" tone="muted">
        {t('manualEntry')}
      </Text>

      {/* BR-020-24/25 */}
      <GuideStamp label={t('stamp.verifiedAsOf')} />

      <div>
        <Button asChild variant="outline">
          {/* rel="noreferrer": an external financial portal, and the referrer
              would leak which page of this app the user came from. */}
          <a href={B3_PORTAL_URL} target="_blank" rel="noreferrer">
            {t('openPortal')}
          </a>
        </Button>
      </div>
    </Stack>
  );
}
