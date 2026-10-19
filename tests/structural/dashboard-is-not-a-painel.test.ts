import { describe, expect, it } from 'vitest';
import messages from '@/i18n/messages/pt-BR.json';

/**
 * SPEC-022 BR-022-01 (amended) / DL-022-16 — the landing destination is
 * **Dashboard**, not "Painel" (#243). The address was always `/dashboard`;
 * only the label changed, and a label that survives in one corner — the
 * onboarding guide's "Ir para o painel", a sign-in prompt — names a
 * destination the sidebar no longer shows.
 *
 * No pt-BR string uses the word at all: the catalogue has no other "painel"
 * (the design system's panels are never named in copy), so any occurrence is
 * the old destination's name.
 */

const PAINEL = /\bpainel\b/i;

function* leaves(node: unknown, path: readonly string[] = []): Generator<[string, string]> {
  if (typeof node === 'string') {
    yield [path.join('.'), node];
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) yield* leaves(value, [...path, key]);
  }
}

const offendersIn = (catalogue: unknown): string[] =>
  [...leaves(catalogue)]
    .filter(([, value]) => PAINEL.test(value))
    .map(([key, value]) => `${key} = "${value}"`);

describe('the landing destination is "Dashboard" (SPEC-022 BR-022-01, DL-022-16)', () => {
  it('no pt-BR string names it "Painel"', () => {
    expect(offendersIn(messages)).toEqual([]);
  });

  it('the navigation and the page title say "Dashboard"', () => {
    expect(messages.nav.dashboard).toBe('Dashboard');
    expect(messages.dashboard.title).toBe('Dashboard');
  });

  it('would catch the old name in any case, and spare a word that only contains it', () => {
    expect(
      offendersIn({ a: 'Ir para o painel', b: 'Painel', c: 'o PAINEL', d: 'painéis' }),
    ).toEqual(['a = "Ir para o painel"', 'b = "Painel"', 'c = "o PAINEL"']);
  });
});
