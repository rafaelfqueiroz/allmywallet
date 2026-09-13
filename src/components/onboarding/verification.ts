import { BusinessDate } from '@/core/shared/clock';

/**
 * SPEC-020 BR-020-24/25 — the guide's own "verified against B3 as of" stamp.
 *
 * The export guide (`ExportGuideContent`) is drawn by this project rather than
 * screenshotted (BR-020-23), which means nothing fails loudly when B3 actually
 * moves a tab or a button — the only signal is a human having looked recently.
 * Each entry below is one such look: the date it happened, and the fingerprint
 * of the B3-reading code as it stood then.
 *
 * `tests/structural/b3-guide-stamp.test.ts` recomputes the fingerprint on every
 * run. A change to that code is evidence B3's exports moved (BR-020-25), so
 * when the fingerprint no longer matches the latest entry the test fails until
 * someone re-verifies the guide and **appends** a new entry. The test also
 * requires each entry's date to be later than the one before it and every
 * fingerprint to be new, which is what ties the date to the hash: pasting a
 * fresh hash without a fresh, later date fails.
 *
 * Literals rather than computed at import time — this module is read by Server
 * Components on every request, and the value only changes when a human
 * updates it by hand.
 */
export interface B3GuideVerification {
  readonly asOf: BusinessDate;
  /** See `computeB3ParserFingerprint` in the structural test for the algorithm. */
  readonly parserFingerprint: string;
}

/** Oldest first. Append; never edit an entry that has shipped. */
export const B3_GUIDE_VERIFICATIONS: readonly B3GuideVerification[] = [
  {
    // #88's capture of investidor.b3.com.br ("Exibindo: … 21/08/2026").
    asOf: BusinessDate.of('2026-08-21'),
    parserFingerprint: '38dda58d53ec45f8083e35084570a72818df31d1b3fc26f31c556f7882dc1730',
  },
];

function latestVerification(): B3GuideVerification {
  const latest = B3_GUIDE_VERIFICATIONS[B3_GUIDE_VERIFICATIONS.length - 1];
  if (latest === undefined) throw new Error('B3_GUIDE_VERIFICATIONS is empty');
  return latest;
}

/** BR-020-24 — the date rendered in the guide's stamp. */
export const B3_GUIDE_VERIFIED_AS_OF: BusinessDate = latestVerification().asOf;
