import { describe, expect, it } from 'vitest';
import { Money } from '@/core/shared/money';
import type { OpportunityAlert } from '@/core/opportunity/ports';
import { renderOpportunityEmail } from '@/adapters/email/opportunity-email';

/**
 * SPEC-018 BR-018-28/AC-17 — a scan over the actual rendered output, not a
 * description of what the function is supposed to do. BR-018-18/AC — the
 * non-advisory wording is asserted here mechanically as a floor; the human
 * review the issue's Test plan calls for is still the final check.
 */

const UNSUBSCRIBE_URL = 'https://allmywallet.example.com/unsubscribe?token=abc.def';

function aBoundAlert(overrides: Partial<OpportunityAlert> = {}): OpportunityAlert {
  return {
    assetCode: 'PETR4',
    assetName: 'Petrobras PN',
    price: Money.fromString('29.50'),
    quotedAt: new Date('2026-03-16T13:00:00Z'),
    source: 'brapi_free',
    state: 'buy',
    matched: 'lower',
    threshold: Money.fromString('30'),
    ...overrides,
  };
}

// A handful of strings that would make this email read as the product's own
// recommendation rather than a report of the user's own rule (BR-018-18/
// DL-018-07). Deliberately *not* the bare word "recomend" — the copy's own
// disclaimer ("não recomenda comprar, vender ou manter") contains it as a
// negation, which is exactly the wording BR-018-18 wants and would be a false
// positive here; these phrases are the ones that would only appear if the
// product presented the state as its own endorsement.
const ADVISORY_PHRASES = [
  'recomendamos',
  'sugerimos',
  'hora de comprar',
  'hora de vender',
  'oportunidade detectada',
  'você deveria',
];

// Personal/financial data this email must never carry (BR-018-28).
const CPF_PATTERN = /\d{3}\.?\d{3}\.?\d{3}-?\d{2}/;
const FORBIDDEN_TERMS = ['cpf', 'posição', 'quantidade', 'patrimônio', 'saldo'];

describe('renderOpportunityEmail — BR-018-28 (no CPF, no position size, no portfolio value)', () => {
  it('a lower-bound alert carries only the asset, price, threshold and state', () => {
    const alert = aBoundAlert();
    const rendered = renderOpportunityEmail(alert, UNSUBSCRIBE_URL);

    for (const body of [rendered.subject, rendered.text, rendered.html]) {
      expect(body).not.toMatch(CPF_PATTERN);
      for (const term of FORBIDDEN_TERMS) {
        expect(body.toLowerCase()).not.toContain(term);
      }
    }

    expect(rendered.text).toContain('PETR4');
    // `formatCurrency` joins the symbol and figure with a non-breaking space
    // (`src/i18n/format.test.ts`'s own `NBSP` constant) — asserting on the
    // figure and the symbol separately avoids that fragility.
    expect(rendered.text).toContain('R$');
    expect(rendered.text).toContain('29,50');
    expect(rendered.text).toContain('30,00');
    expect(rendered.html).toContain(UNSUBSCRIBE_URL);
  });

  it('an upper-bound alert with the opposite state renders the opposite label', () => {
    const alert = aBoundAlert({
      state: 'sell',
      matched: 'upper',
      threshold: Money.fromString('45'),
      price: Money.fromString('45.10'),
    });
    const rendered = renderOpportunityEmail(alert, UNSUBSCRIBE_URL);
    expect(rendered.text).toContain('limite de venda');
    // Not the bare word "compra" — the fixed disclaimer sentence present in
    // every message ("não recomenda comprar, vender ou manter") contains
    // "comprar" regardless of which state this alert carries.
    expect(rendered.text).not.toContain('limite de compra');
  });

  it('a default-band alert (no threshold) still renders without a threshold figure', () => {
    const alert = aBoundAlert({ state: 'hold', matched: 'default', threshold: null });
    const rendered = renderOpportunityEmail(alert, UNSUBSCRIBE_URL);
    expect(rendered.text).toContain('PETR4');
    expect(rendered.text).toContain('manutenção');
  });

  it('never presents the state as the product’s own recommendation (BR-018-18)', () => {
    for (const state of ['buy', 'hold', 'sell'] as const) {
      const alert = aBoundAlert({
        state,
        threshold: state === 'hold' ? null : Money.fromString('30'),
        matched: state === 'hold' ? 'default' : 'lower',
      });
      const rendered = renderOpportunityEmail(alert, UNSUBSCRIBE_URL);
      const lowered = `${rendered.subject} ${rendered.text}`.toLowerCase();
      for (const phrase of ADVISORY_PHRASES) {
        expect(lowered).not.toContain(phrase);
      }
    }
  });

  it('discloses the quote’s own timestamp, source and the ~30 minute delay (BR-018-15)', () => {
    const rendered = renderOpportunityEmail(aBoundAlert(), UNSUBSCRIBE_URL);
    expect(rendered.text).toContain('brapi_free');
    expect(rendered.text).toMatch(/30 minutos/);
  });

  it('carries an unsubscribe link built from the caller-supplied URL', () => {
    const rendered = renderOpportunityEmail(aBoundAlert(), UNSUBSCRIBE_URL);
    expect(rendered.html).toContain(`href="${UNSUBSCRIBE_URL}"`);
  });
});
