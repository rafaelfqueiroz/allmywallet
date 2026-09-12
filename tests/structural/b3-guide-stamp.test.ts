import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { B3_GUIDE_VERIFIED_AS_OF, B3_PARSER_FINGERPRINT } from '@/components/onboarding/verification';

/**
 * SPEC-020 BR-020-25 — "the stamp is re-verified whenever a B3 parser changes
 * — a parser change is evidence that B3 has moved." The guide itself
 * (`ExportGuideContent`/`ExtractDiagram`) cannot detect that on its own: it is
 * a set of diagrams this project drew by hand, and nothing about editing
 * `src/adapters/ingestion/xlsx/movimentacao.ts` touches those files. This test
 * is the mechanical trigger BR-020-25 needs — it recomputes a fingerprint over
 * the parser sources and fails the moment it no longer matches what
 * `verification.ts` has committed, which is exactly when a parser last
 * changed and the guide has not yet been re-checked against B3 for it.
 *
 * **The algorithm is the single source of truth for the constant.** Rather
 * than describe a hash in prose and hope `verification.ts`'s own comment
 * stays in sync, this file *is* the definition: `B3_PARSER_FINGERPRINT` is
 * whatever this test computes, today. A parser edit changes the computed
 * value, the test fails, and the fix is exactly BR-020-25's own instruction —
 * re-verify the guide against B3, then update both constants in
 * `src/components/onboarding/verification.ts`.
 */
describe('the B3 guide stamp is tied to the parsers it documents (SPEC-020 BR-020-24/25)', () => {
  const parserDir = join(process.cwd(), 'src/adapters/ingestion/xlsx');

  /** Sorted, non-test, non-fixture `.ts` sources — the parsers themselves. */
  function parserSourceFiles(): string[] {
    return readdirSync(parserDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .sort();
  }

  function computeFingerprint(): string {
    const hash = createHash('sha256');
    for (const name of parserSourceFiles()) {
      const relativePath = `src/adapters/ingestion/xlsx/${name}`;
      hash.update(`${relativePath}\n`);
      hash.update(`${readFileSync(join(parserDir, name), 'utf8')}\n`);
    }
    return hash.digest('hex');
  }

  it('has parser source files to fingerprint', () => {
    // Guards against a renamed directory silently turning this test into a
    // no-op that always passes.
    expect(parserSourceFiles().length).toBeGreaterThan(0);
  });

  it('matches the fingerprint committed in verification.ts', () => {
    expect(
      B3_PARSER_FINGERPRINT,
      'SPEC-020 BR-020-25: a B3 xlsx parser changed since the guide was last verified against B3. ' +
        're-check ExportGuideContent/ExtractDiagram against investidor.b3.com.br, then update both ' +
        'B3_GUIDE_VERIFIED_AS_OF and B3_PARSER_FINGERPRINT in src/components/onboarding/verification.ts.',
    ).toBe(computeFingerprint());
  });

  it('records a real verification date, not a placeholder', () => {
    // BusinessDate.of already throws on a malformed string; this asserts the
    // stamp is not left at some obviously-fake sentinel like the epoch.
    expect(B3_GUIDE_VERIFIED_AS_OF > '2020-01-01').toBe(true);
  });
});
