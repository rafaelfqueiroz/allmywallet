/**
 * SPEC-005 BR-005-14 / SPEC-007 BR-007-08 (#136) — the explicit, reviewable
 * institution alias table, and the mechanical normalisation that feeds it.
 *
 * B3 spells one institution several ways across extracts and periods. A
 * position is keyed by `(asset, institution)`, so each spelling became its own
 * custody location and split one real holding in two: the owner's ledger held
 * WEGE3's buys at `INTER DISTRIBUIDORA DE TITULOS E VALORES MOBILIARIOS LTDA`
 * and its `Desdobro` at `INTER DTVM LTDA`, and the event refused `no_basis`
 * against a position of zero.
 *
 * **Two rules, in this order.**
 *
 * 1. `normalizeInstitutionName` — case, accents, punctuation and runs of
 *    whitespace carry no meaning in a broker's name on a B3 extract, so two
 *    spellings differing only in those are the same institution. This is
 *    mechanical and needs no table: `XP INVESTIMENTOS CORRETORA DE CAMBIO,
 *    TITULOS E VALORES MOBI` and the same text without the comma match here.
 *
 * 2. `INSTITUTION_ALIASES` — everything else is listed by hand. It has to be:
 *    `INTER DTVM LTDA` is an *abbreviation* of `INTER DISTRIBUIDORA DE TITULOS
 *    E VALORES MOBILIARIOS LTDA`, and no normalisation brings an expansion
 *    together with its acronym without also bringing together names that must
 *    stay apart. Two of those are in the owner's own data:
 *
 *      - `CLEAR CORRETORA - GRUPO XP` is not `XP INVESTIMENTOS CCTVM S/A`.
 *        Same group, two brokers, two custody locations.
 *      - `BANCO INTER S/A` is not `INTER DTVM LTDA`. The bank issues the
 *        paper; the DTVM holds the listed custody.
 *
 *    A rule loose enough to merge Inter's two spellings by shared tokens
 *    merges both of those pairs too, and a wrongly merged pair is worse than
 *    the split it fixes — the split is at least visible as two rows.
 *
 * **A spelling this table does not know still creates its own institution**,
 * exactly as today. That is the deliberate failure mode: a new row is visible
 * and reversible, a fuzzy match is neither.
 *
 * **Adding an entry here does not repair a ledger that already split.** Rows
 * are keyed by institution *id*, so an alias added later needs a data
 * migration in the shape of `0024_merge_institution_spellings.sql` to move
 * them — a required step of such a change, not an optional one, the same
 * bargain BR-005-20c's conversion definitions make.
 *
 * Pure and total (AR-01).
 */

export interface InstitutionAlias {
  /**
   * The spelling that survives a merge. Always one B3 itself writes — never a
   * tidied display name, so nothing in the product shows an institution under
   * a name no extract ever carried.
   */
  readonly canonicalName: string;
  /** Other observed spellings of the same institution, canonical excluded. */
  readonly spellings: readonly string[];
}

/**
 * Spellings observed in B3 extracts. Public institution names only — no
 * personal data, and nothing about who holds what (BR-004-02).
 */
export const INSTITUTION_ALIASES: readonly InstitutionAlias[] = [
  {
    // The fullest spelling B3 writes for Inter's DTVM. `INTER DTVM LTDA`
    // appears on later extracts for the same custody.
    canonicalName: 'INTER DISTRIBUIDORA DE TITULOS E VALORES MOBILIARIOS LTDA',
    spellings: ['INTER DTVM LTDA'],
  },
  {
    // B3 writes XP's name in full, truncated at 60 characters, and by its
    // acronym CCTVM. `CLEAR CORRETORA - GRUPO XP` is deliberately absent.
    canonicalName: 'XP INVESTIMENTOS CORRETORA DE CAMBIO TITULOS E VALORES MOBILIARIOS S/A',
    spellings: [
      'XP INVESTIMENTOS CCTVM S/A',
      'XP INVESTIMENTOS CORRETORA DE CAMBIO, TITULOS E VALORES MOBI',
    ],
  },
];

/**
 * Case, accents, punctuation and whitespace runs removed; nothing else. A
 * legal-form suffix (`S/A`, `LTDA`, `CCTVM`, `DTVM`) is **kept**, because two
 * institutions of one group differ by exactly that (`CLEAR CORRETORA` and
 * `XP INVESTIMENTOS` both drop to their group name without it).
 */
export function normalizeInstitutionName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

const CANONICAL_BY_NORMALIZED = new Map<string, string>(
  INSTITUTION_ALIASES.flatMap((alias) =>
    [alias.canonicalName, ...alias.spellings].map(
      (spelling) => [normalizeInstitutionName(spelling), alias.canonicalName] as const,
    ),
  ),
);

/**
 * The name an institution row is **created** under. Replaced outright for a
 * spelling the alias table knows; otherwise the extract's own text, with only
 * its surrounding and repeated whitespace removed, so nothing is stored under
 * a name no extract ever carried.
 */
export function canonicalInstitutionName(name: string): string {
  const normalized = normalizeInstitutionName(name);
  return CANONICAL_BY_NORMALIZED.get(normalized) ?? name.replace(/\s+/g, ' ').trim();
}

/**
 * The value two names are **compared** on: one institution, one key.
 *
 * `DrizzleInstitutionResolver` indexes the institutions already in the
 * catalogue by this key, so a spelling arriving for the first time reuses the
 * row an earlier spelling created instead of adding a second one — including
 * the pre-merge row of a ledger where the canonical spelling is not the one
 * that happens to exist.
 */
export function institutionIdentityKey(name: string): string {
  return normalizeInstitutionName(canonicalInstitutionName(name));
}
