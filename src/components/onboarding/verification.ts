import { BusinessDate } from '@/core/shared/clock';

/**
 * SPEC-020 BR-020-24/25 — the guide's own "verified against B3 as of" stamp.
 *
 * **Two constants, one obligation.** The export guide (`ExportGuideContent`)
 * is drawn by this project rather than screenshotted (BR-020-23), which means
 * nothing here fails loudly when B3 actually moves a tab or a button — the
 * only signal is a human having looked recently. `B3_GUIDE_VERIFIED_AS_OF` is
 * that look, dated. `B3_PARSER_FINGERPRINT` is what
 * `tests/structural/b3-guide-stamp.test.ts` recomputes on every run: a parser
 * change is evidence B3's exports moved (BR-020-25), so if the fingerprint no
 * longer matches what is committed here, the guide has not been re-checked
 * against the change and the test fails rather than shipping a stale diagram
 * silently.
 *
 * Both are plain string/BusinessDate literals, not computed at import time —
 * this module is read by Server Components that render on every request, and
 * hashing seven source files on every render would be pointless work for a
 * value that only changes when a human updates it by hand.
 */

/** BR-020-24 — the date the guide's structure was last checked against investidor.b3.com.br (#88's capture). */
export const B3_GUIDE_VERIFIED_AS_OF: BusinessDate = BusinessDate.of('2026-08-21');

/**
 * sha256 over the sorted non-test source files of `src/adapters/ingestion/xlsx/`
 * (`common.ts`, `detect.ts`, `index.ts`, `movimentacao.ts`, `negociacao.ts`,
 * `posicao.ts`, `strip-cpf.ts`), each entry hashed as `"<relative path>\n<file
 * contents>\n"` in sorted-path order. `tests/structural/b3-guide-stamp.test.ts`
 * recomputes this exact algorithm and is the single source of truth for it —
 * see that file rather than re-deriving the hash by hand.
 */
export const B3_PARSER_FINGERPRINT =
  '720eff8f32004dc10f5037bd950c3ea136d8e1f2ef484b457048b38b89812c5b';
