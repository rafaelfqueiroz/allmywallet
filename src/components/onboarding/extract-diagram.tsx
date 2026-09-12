import { getTranslations } from 'next-intl/server';

/**
 * SPEC-020 BR-020-23/DL-020-06 — a schematic of investidor.b3.com.br, drawn by
 * this project rather than captured from it. No screenshot of a third-party
 * interface is committed to this repository (DV-24, TS-19): B3 sits behind a
 * login, and a real capture carries the account holder's name, institution and
 * holdings, which is exactly the data this product exists to keep out of its
 * own logs and images alike.
 *
 * **This diagram is decorative** (`aria-hidden`), because it is a picture and
 * BR-020-31 requires the steps to survive with images suppressed — the ordered
 * text list next to it (`ExportGuideContent`) carries the same information in
 * words, and is the thing a screen reader or a text-only render actually reads.
 * SPEC-016 BR-016-16 is the general form of the same rule: a chart, and this is
 * one, is never the sole carrier of information.
 *
 * Three extracts, two structural shapes:
 *  - Movimentação and Negociação are tabs under **Extratos** (alongside
 *    Eventos and Ofertas públicas, which this product does not use — shown to
 *    depict the real tab bar rather than a cropped one that implies there are
 *    only two tabs);
 *  - Posição is under **Minha carteira → Investimentos** (alongside
 *    Garantias).
 *
 * Every colour is a design token (`var(--token)`, DS-04), which is what keeps
 * this legible in both themes without a second dark-mode drawing — the
 * variable itself resolves differently per theme, the markup does not change.
 */

export type ExtractDiagramStep = 'movimentacao' | 'negociacao' | 'posicao';

const EXTRATOS_TABS = ['movimentacao', 'negociacao', 'eventos', 'ofertas'] as const;
const INVESTIMENTOS_TABS = ['posicao', 'garantias'] as const;

export async function ExtractDiagram({ step }: { readonly step: ExtractDiagramStep }) {
  const t = await getTranslations('onboarding.diagram');

  const inExtratos = step === 'movimentacao' || step === 'negociacao';
  const tabKeys = inExtratos ? EXTRATOS_TABS : INVESTIMENTOS_TABS;
  const groupLabel = inExtratos ? t('extratos.groupLabel') : t('investimentos.groupLabel');
  const tabs = tabKeys.map((key) => ({
    key,
    label: inExtratos ? t(`extratos.tabs.${key}`) : t(`investimentos.tabs.${key}`),
  }));
  const activeIndex = tabKeys.findIndex((key) => key === step);

  const railX = 8;
  const railWidth = 64;
  const contentX = railX + railWidth + 12;
  const contentWidth = 400 - contentX - 8;
  const tabY = 44;
  const tabHeight = 22;
  const actionY = 96;
  const actionHeight = 28;

  const tabWidth = contentWidth / tabs.length;

  return (
    <svg
      viewBox="0 0 400 150"
      role="img"
      aria-hidden="true"
      className="w-full max-w-md rounded-md border"
      style={{ background: 'var(--card)' }}
    >
      {/* Left rail — B3's own side navigation, drawn generically: what matters
          here is only that Posição lives one level deeper than Movimentação
          and Negociação (Minha carteira → Investimentos vs. Extratos), which
          the group label above the tab bar states in words. */}
      <rect
        x={railX}
        y={8}
        width={railWidth}
        height={134}
        rx={4}
        fill="var(--muted)"
        stroke="var(--border)"
      />
      <rect x={railX + 10} y={22} width={railWidth - 20} height={6} rx={3} fill="var(--border)" />
      <rect x={railX + 10} y={38} width={railWidth - 20} height={6} rx={3} fill="var(--border)" />
      <rect x={railX + 10} y={54} width={railWidth - 20} height={6} rx={3} fill="var(--border)" />

      {/* The section the tab bar sits under. */}
      <text x={contentX} y={26} fontSize="11" fill="var(--muted-foreground)">
        {groupLabel}
      </text>

      {/* Tab bar, target tab highlighted. */}
      <g>
        {tabs.map((tab, index) => {
          const x = contentX + index * tabWidth;
          const active = index === activeIndex;
          return (
            <g key={tab.key}>
              <rect
                x={x}
                y={tabY}
                width={tabWidth - 4}
                height={tabHeight}
                rx={3}
                fill={active ? 'var(--primary)' : 'var(--secondary)'}
              />
              <text
                x={x + (tabWidth - 4) / 2}
                y={tabY + tabHeight / 2 + 3}
                fontSize="9"
                textAnchor="middle"
                fill={active ? 'var(--primary-foreground)' : 'var(--secondary-foreground)'}
              >
                {tab.label}
              </text>
            </g>
          );
        })}
      </g>

      {/* Action bar: Filtrar (period) and the highlighted Baixar button. */}
      <rect
        x={contentX}
        y={actionY}
        width={contentWidth * 0.45}
        height={actionHeight}
        rx={4}
        fill="var(--background)"
        stroke="var(--border)"
      />
      <text
        x={contentX + (contentWidth * 0.45) / 2}
        y={actionY + actionHeight / 2 + 3}
        fontSize="10"
        textAnchor="middle"
        fill="var(--foreground)"
      >
        {t('filtrar')}
      </text>

      <rect
        x={contentX + contentWidth * 0.55}
        y={actionY}
        width={contentWidth * 0.45}
        height={actionHeight}
        rx={4}
        fill="var(--positive)"
      />
      <text
        x={contentX + contentWidth * 0.55 + (contentWidth * 0.45) / 2}
        y={actionY + actionHeight / 2 + 3}
        fontSize="10"
        fontWeight="bold"
        textAnchor="middle"
        fill="var(--background)"
      >
        {t('baixar')}
      </text>

      {/* Numbered callouts — purely visual pointers; digits carry no letters so
          they need no translation, and the actual instructions are the ordered
          text list this diagram is paired with, never this circle. */}
      <circle
        cx={contentX + (contentWidth * 0.45) / 2}
        cy={actionY - 10}
        r={7}
        fill="var(--chart-1)"
      />
      <text
        x={contentX + (contentWidth * 0.45) / 2}
        y={actionY - 7}
        fontSize="9"
        textAnchor="middle"
        fill="var(--background)"
      >
        1
      </text>

      <circle
        cx={contentX + contentWidth * 0.55 + (contentWidth * 0.45) / 2}
        cy={actionY - 10}
        r={7}
        fill="var(--chart-1)"
      />
      <text
        x={contentX + contentWidth * 0.55 + (contentWidth * 0.45) / 2}
        y={actionY - 7}
        fontSize="9"
        textAnchor="middle"
        fill="var(--background)"
      >
        2
      </text>
    </svg>
  );
}
