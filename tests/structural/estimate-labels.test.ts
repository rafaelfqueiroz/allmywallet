import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import messages from '@/i18n/messages/pt-BR.json';

/**
 * SPEC-022 BR-022-32 (amended 2026-10-12, DL-022-19) — estimates are two
 * concepts with two labels: **Valor estimado** beside a value priced from a
 * contracted indexer (SPEC-009 BR-009-11), **Custo estimado** beside a cost or
 * *preço médio* that includes an acquisition B3 states no price for (SPEC-007
 * BR-007-06). Each opens its explanation from an info icon — never only the
 * browser's native `title`, which touch and keyboard users never see.
 *
 * The bare "Estimado" this replaces named both facts with one word; "Preço
 * estimado" was the older duplicate. Neither may come back as a label. A
 * *sentence* that explains an estimate ("Preço estimado pelo fechamento de
 * {date}…") is not a label and is not barred.
 */

const BARRED = new Set(['estimado', 'preço estimado']);

/**
 * The spec's AC: "no other estimate wording exists in the pt-BR catalogue." A
 * short entry that names an estimate — a badge, a column, a label — is either
 * one of the two labels or a third wording. Long entries are explanations.
 */
const LABEL_LENGTH = 60;
const ESTIMATE_WORDING = /estimad|acruad/i;
const LABELS: Record<string, string> = {
  'common.valueEstimated': 'Valor estimado',
  'common.costEstimated': 'Custo estimado',
};

function* leaves(node: unknown, path: readonly string[] = []): Generator<[string, string]> {
  if (typeof node === 'string') {
    yield [path.join('.'), node];
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) yield* leaves(value, [...path, key]);
  }
}

const ROOT = join(__dirname, '..', '..');

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (/\.tsx$/.test(entry.name) && !entry.name.endsWith('.test.tsx')) yield path;
  }
}

const sources = [...files(join(ROOT, 'src'))].map((path) => ({
  path: relative(ROOT, path),
  text: readFileSync(path, 'utf8'),
}));

/** A native title reading any estimate key or prop — `estimate.*`, `costEstimated.*`, `estimatedHint`, `accrued.*`… */
const EXPLANATION = /title=\{[^}]*(?:[eE]stimat|accrued)/;

/** A badge spelling an estimate label itself, instead of `EstimateMarker`. */
const HAND_ROLLED = /<Badge\b[^>]*>\s*\{[^}]*(?:valueEstimated|costEstimated)\b/;

describe('two estimate labels (BR-022-32)', () => {
  it('no catalogue entry reads "Estimado" alone or "Preço estimado"', () => {
    const offenders = [...leaves(messages)]
      .filter(([, value]) => BARRED.has(value.trim().toLowerCase()))
      .map(([key, value]) => `${key} = "${value}"`);

    expect(offenders).toEqual([]);
  });

  it('has no third estimate wording: a short entry naming an estimate is one of the two labels', () => {
    const offenders = [...leaves(messages)]
      .filter(([key]) => !(key in LABELS))
      .filter(([, value]) => value.length <= LABEL_LENGTH && ESTIMATE_WORDING.test(value))
      .map(([key, value]) => `${key} = "${value}"`);

    expect(offenders).toEqual([]);
  });

  it('keeps each label under exactly one key', () => {
    const wanted = new Set(Object.values(LABELS).map((label) => label.toLowerCase()));
    const found = Object.fromEntries(
      [...leaves(messages)].filter(([, value]) => wanted.has(value.trim().toLowerCase())),
    );

    expect(found).toEqual(LABELS);
  });

  it('never carries an estimate explanation in a native title alone', () => {
    const offenders = sources
      .filter(({ text }) => EXPLANATION.test(text) || HAND_ROLLED.test(text))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });
});
