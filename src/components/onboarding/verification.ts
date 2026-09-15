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
 * requires each entry's date to be no earlier than the one before it and every
 * fingerprint to be new. Same-day entries are allowed because two parser
 * changes can be verified on one day (#108); a stamp that moves backwards, or
 * a hash reused under a new date, still fails.
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
  {
    // #108: the Posição parser was rewritten for B3's real per-tab layout; the
    // old layout had been invented, not changed by B3. The owner exported a
    // real Posição that day via Minha carteira → Investimentos → Posição →
    // Baixar. Movimentação and Negociação were not re-checked (last seen on
    // 2026-08-21); that is still open on #108.
    asOf: BusinessDate.of('2026-09-14'),
    parserFingerprint: 'cd1fc474859c90ab5d5104143bd872bac740da36ea1ede2a1f7c9d1b91f40c76',
  },
  {
    // #108, the Movimentação/Negociação half: both parsers rewritten for B3's
    // real exports. The owner exported both via Extratos → Movimentação →
    // Baixar and Extratos → Negociação → Baixar and confirmed the paths, so
    // all three guide steps are verified as of this entry.
    asOf: BusinessDate.of('2026-09-14'),
    parserFingerprint: '3c568ee6f4525d7623382f305c71634e13315d4d067400891152e8778a3f3607',
  },
  {
    // #110: movement map v3 and the ignored mirrors. Only the table grew, from
    // the type strings in the same real Movimentação verified above; no parser
    // and no B3 screen moved, so the guide's steps stand as of that entry.
    asOf: BusinessDate.of('2026-09-14'),
    parserFingerprint: '3895ecf3dede3f2f604ff6ce64193882e377fbafe8347873ec76824c2a14d1e1',
  },
];

function latestVerification(): B3GuideVerification {
  const latest = B3_GUIDE_VERIFICATIONS[B3_GUIDE_VERIFICATIONS.length - 1];
  if (latest === undefined) throw new Error('B3_GUIDE_VERIFICATIONS is empty');
  return latest;
}

/** BR-020-24 — the date rendered in the guide's stamp. */
export const B3_GUIDE_VERIFIED_AS_OF: BusinessDate = latestVerification().asOf;
