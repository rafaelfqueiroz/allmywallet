import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { B3_GUIDE_VERIFICATIONS } from '@/components/onboarding/verification';

/**
 * SPEC-020 BR-020-25 — "the stamp is re-verified whenever a B3 parser changes
 * — a parser change is evidence that B3 has moved." The guide itself
 * (`ExportGuideContent`/`ExtractDiagram`) cannot detect that on its own: it is
 * a set of diagrams this project drew by hand. This test is the mechanical
 * trigger — it fingerprints the code that reads B3's extracts and fails the
 * moment that no longer matches the latest verification entry.
 *
 * **What is fingerprinted.** Every non-test source of the xlsx parsers, plus
 * `src/core/ingestion/movement-map.ts`: when B3 renames or adds a Movimentação
 * label, that map is where the fix lands, and it is the change most likely to
 * mean B3's screens moved too.
 *
 * **Whitespace is stripped before hashing**, so a formatter reflow does not
 * demand a trip to B3; any change to what the code says does.
 *
 * The fix when this fails is BR-020-25's own instruction: re-check the guide
 * against investidor.b3.com.br, then append a new entry — today's date and the
 * fingerprint this test prints — to `B3_GUIDE_VERIFICATIONS` in
 * `src/components/onboarding/verification.ts`.
 */

const PARSER_DIR = 'src/adapters/ingestion/xlsx';
const EXTRA_SOURCES = ['src/core/ingestion/movement-map.ts'];

function fingerprintedSources(): string[] {
  const parsers = readdirSync(join(process.cwd(), PARSER_DIR), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => `${PARSER_DIR}/${name}`);
  return [...parsers, ...EXTRA_SOURCES].sort();
}

export function computeB3ParserFingerprint(): string {
  const hash = createHash('sha256');
  for (const path of fingerprintedSources()) {
    const content = readFileSync(join(process.cwd(), path), 'utf8').replace(/\s+/g, '');
    hash.update(`${path}\n${content}\n`);
  }
  return hash.digest('hex');
}

describe('the B3 guide stamp is tied to the code that reads B3 (SPEC-020 BR-020-24/25)', () => {
  it('fingerprints the parsers and the movement map', () => {
    // Guards against a renamed directory silently turning this into a no-op.
    const sources = fingerprintedSources();
    expect(sources.filter((path) => path.startsWith(PARSER_DIR)).length).toBeGreaterThan(0);
    expect(sources).toContain('src/core/ingestion/movement-map.ts');
  });

  it('matches the latest verification entry', () => {
    const latest = B3_GUIDE_VERIFICATIONS[B3_GUIDE_VERIFICATIONS.length - 1];
    const computed = computeB3ParserFingerprint();
    expect(
      latest?.parserFingerprint,
      'SPEC-020 BR-020-25: the code that reads B3 extracts changed since the guide was last ' +
        'verified. Re-check ExportGuideContent/ExtractDiagram against investidor.b3.com.br, then ' +
        `append { asOf: <today>, parserFingerprint: '${computed}' } to B3_GUIDE_VERIFICATIONS in ` +
        'src/components/onboarding/verification.ts.',
    ).toBe(computed);
  });

  it('requires every new fingerprint to arrive with a verification dated no earlier than the last', () => {
    // #108: two parser changes verified on the same day share a date. A
    // strictly-later rule forced the second entry to claim tomorrow, which the
    // guide then showed users (BR-020-24). Moving backwards still fails, and a
    // reused fingerprint fails below.
    const dates = B3_GUIDE_VERIFICATIONS.map((entry) => entry.asOf);
    for (let index = 1; index < dates.length; index += 1) {
      expect(
        (dates[index] as string) >= (dates[index - 1] as string),
        'each verification must be dated no earlier than the previous one',
      ).toBe(true);
    }
    const fingerprints = B3_GUIDE_VERIFICATIONS.map((entry) => entry.parserFingerprint);
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });
});
