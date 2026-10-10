import { describe, expect, it } from 'vitest';
import messages from '@/i18n/messages/pt-BR.json';

/**
 * SPEC-022 BR-022-32 — "each concept has one wording across all screens. An
 * estimated value carries the same label everywhere." The screens used to mix
 * "Estimado" and "Preço estimado", one key per site.
 *
 * The label lives under exactly one key, `common.estimated`, and every badge
 * or column that needs it reads that key. This fails the moment a second
 * catalogue entry spells the label out again — which is how the duplicates
 * accumulated in the first place: a new screen needs "the estimated badge",
 * does not find the existing one, and adds its own.
 *
 * What it does not forbid is a *sentence* that explains an estimate ("Preço
 * estimado pelo fechamento de {date}…"): the label is a word beside a figure,
 * the explanation is the tooltip behind it, and the two are meant to differ
 * (cost estimate versus valuation estimate).
 */

const LABELS = new Set(['estimado', 'preço estimado']);
const THE_KEY = 'common.estimated';

function* leaves(node: unknown, path: readonly string[] = []): Generator<[string, string]> {
  if (typeof node === 'string') {
    yield [path.join('.'), node];
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) yield* leaves(value, [...path, key]);
  }
}

describe('one wording for an estimated value (BR-022-32)', () => {
  it('keeps the label under `common.estimated` and nowhere else', () => {
    const offenders = [...leaves(messages)]
      .filter(([key, value]) => key !== THE_KEY && LABELS.has(value.trim().toLowerCase()))
      .map(([key, value]) => `${key} = "${value}"`);

    expect(offenders).toEqual([]);
  });

  it('has the label, and it is the short one', () => {
    expect(messages.common.estimated).toBe('Estimado');
  });
});
