import { describe, expect, it } from 'vitest';
import { ExtractDiagram, type ExtractDiagramLabels } from '@/components/onboarding/extract-diagram';
import { audit, render } from '@/components/test-utils';

/**
 * SPEC-020 BR-020-23/31 — the diagram is decorative (`aria-hidden`), and the
 * real information it depicts (which tab, which button) is carried by the
 * translated labels a caller supplies, never invented here. The ordered text
 * list that actually conveys the export steps to a screen reader lives in
 * `ExportGuideContent`, an async Server Component this harness cannot render
 * (`getTranslations` throws outside a Next.js request — see the module
 * comment on why `ExtractDiagram` itself takes plain props instead); that
 * pairing is asserted end to end in `tests/e2e/onboarding.spec.ts`'s "text
 * survives with every svg hidden" case (AC-20).
 */
const EXTRATOS_LABELS: ExtractDiagramLabels = {
  groupLabel: 'Extratos',
  tabs: [
    { key: 'movimentacao', label: 'Movimentação' },
    { key: 'negociacao', label: 'Negociação' },
    { key: 'eventos', label: 'Eventos' },
    { key: 'ofertas', label: 'Ofertas públicas' },
  ],
  activeTabIndex: 0,
  filtrar: 'Filtrar',
  baixar: 'Baixar',
};

describe('ExtractDiagram', () => {
  it('is decorative, so it never reaches a screen reader', () => {
    const { container } = render(<ExtractDiagram labels={EXTRATOS_LABELS} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders every tab the caller supplies, with the highlighted one told apart from the rest', () => {
    const { container } = render(<ExtractDiagram labels={EXTRATOS_LABELS} />);
    const texts = Array.from(container.querySelectorAll('text')).map((node) => node.textContent);

    for (const tab of EXTRATOS_LABELS.tabs) {
      expect(texts).toContain(tab.label);
    }

    const rects = Array.from(container.querySelectorAll('rect'));
    // One rect per tab is filled with the primary colour (the active one);
    // the rest use the secondary fill — asserted by count rather than by
    // which exact rect, since the highlight is a fill choice, not a class.
    const highlighted = rects.filter((rect) => rect.getAttribute('fill') === 'var(--primary)');
    expect(highlighted).toHaveLength(1);
  });

  it('renders the Filtrar and Baixar labels the caller supplies', () => {
    const { container } = render(<ExtractDiagram labels={EXTRATOS_LABELS} />);
    const texts = Array.from(container.querySelectorAll('text')).map((node) => node.textContent);
    expect(texts).toContain('Filtrar');
    expect(texts).toContain('Baixar');
  });

  it('draws the Posição/Investimentos shape just as faithfully as the Extratos one', () => {
    const investimentosLabels: ExtractDiagramLabels = {
      groupLabel: 'Minha carteira → Investimentos',
      tabs: [
        { key: 'posicao', label: 'Posição' },
        { key: 'garantias', label: 'Garantias' },
      ],
      activeTabIndex: 0,
      filtrar: 'Filtrar',
      baixar: 'Baixar',
    };
    const { container } = render(<ExtractDiagram labels={investimentosLabels} />);
    const texts = Array.from(container.querySelectorAll('text')).map((node) => node.textContent);
    expect(texts).toContain('Minha carteira → Investimentos');
    expect(texts).toContain('Posição');
    expect(texts).toContain('Garantias');
  });

  it('carries no colour outside the design tokens (DS-04)', () => {
    const { container } = render(<ExtractDiagram labels={EXTRATOS_LABELS} />);
    const painted = container.querySelectorAll('[fill]:not([fill="none"]), [stroke]');
    expect(painted.length).toBeGreaterThan(0);
    for (const node of painted) {
      for (const attr of ['fill', 'stroke']) {
        const value = node.getAttribute(attr);
        if (value && value !== 'none') expect(value).toMatch(/^var\(--[\w-]+\)$/);
      }
    }
  });

  it('has no axe violations', async () => {
    const { container } = render(<ExtractDiagram labels={EXTRATOS_LABELS} />);
    expect(await audit(container)).toHaveNoViolations();
  });
});
