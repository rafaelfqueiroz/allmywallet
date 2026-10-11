import { describe, expect, it } from 'vitest';
import messages from '@/i18n/messages/pt-BR.json';

/**
 * SPEC-022 BR-022-06 — "in the pt-BR interface the whole portfolio is called
 * **Portfólio**, and the purpose groups are called **Carteiras**. 'Carteira'
 * never names the whole portfolio."
 *
 * The catalogue used to say "sua carteira" for the whole portfolio in about
 * twenty places (#209), beside a Carteiras tab that means purpose wallets —
 * one word for two things on one screen. "Carteira" itself stays: it is the
 * right word for a wallet. What this bars is the phrasings that can only mean
 * the whole: *your* carteira, the *complete* carteira, the *consolidated* one.
 *
 * **The one exception is B3's own interface.** Its menu really is called
 * "Minha carteira", and the import guide quotes it so a user can find the
 * extract; rewording it would send them looking for a menu that does not
 * exist. Those keys are listed, by key, so a new one is a decision rather than
 * a slip.
 */

const WHOLE_PORTFOLIO = [
  /\bsua carteira\b/i,
  /\bminha carteira\b/i,
  /\bcarteira (completa|inteira|toda|consolidada)\b/i,
  /\btoda a carteira\b/i,
];

/** B3's menu paths, quoted verbatim from B3's Área do Investidor. */
const B3_MENU_PATHS = new Set([
  'onboarding.guide.steps.posicao.path',
  'onboarding.diagram.investimentos.groupLabel',
]);

function* leaves(node: unknown, path: readonly string[] = []): Generator<[string, string]> {
  if (typeof node === 'string') {
    yield [path.join('.'), node];
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) yield* leaves(value, [...path, key]);
  }
}

const offendersIn = (catalogue: unknown): string[] =>
  [...leaves(catalogue)]
    .filter(([key]) => !B3_MENU_PATHS.has(key))
    .filter(([, value]) => WHOLE_PORTFOLIO.some((pattern) => pattern.test(value)))
    .map(([key, value]) => `${key} = "${value}"`);

describe('"carteira" never names the whole portfolio (SPEC-022 BR-022-06)', () => {
  it('no pt-BR string calls the whole portfolio a carteira', () => {
    expect(offendersIn(messages)).toEqual([]);
  });

  it('the allowlisted keys exist and still quote B3', () => {
    // A renamed key would leave the allowlist exempting nothing, silently.
    const all = new Map(leaves(messages));
    for (const key of B3_MENU_PATHS) expect(all.get(key)).toMatch(/^Minha carteira →/);
  });

  it('would catch the phrasings it exists for, and spare a purpose wallet', () => {
    expect(
      offendersIn({
        a: 'Quanto sua carteira rendeu',
        b: 'Usar os números da carteira completa',
        c: 'Minha carteira → Investimentos',
      }),
    ).toHaveLength(3);
    expect(offendersIn({ a: 'Esta carteira ainda está vazia', b: 'Todas as carteiras' })).toEqual(
      [],
    );
  });
});
