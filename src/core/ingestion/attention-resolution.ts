import type { ImportRow, NormalizedRecord } from '@/core/ingestion/ports';
import {
  classifyMovement,
  conversionEvidenceMovementOf,
  corporateEventMovementOf,
  isIgnoredMovement,
} from '@/core/ingestion/movement-map';
import { PRICE_BEARING_TYPES } from '@/core/ingestion/stage-batch';

/**
 * SPEC-022 BR-022-35 (#215) — what resolves a row left in "Precisa da sua
 * atenção": a re-import, a decision by the user, or a fix not yet shipped.
 *
 * - `reimport` — the parser and map this build ships would stage the row as
 *   something other than `unclassified`: `ignored` (BR-005-19) or mapped with a
 *   usable price (BR-005-18). The batch predates that rule, and importing the
 *   same extract again settles the stored row in place (BR-005-20).
 * - `decide` — the type is one the map knows, by mapping or by name, but this
 *   row is evidence a rule deliberately leaves inert: a price-less credit, a
 *   corporate-event or conversion statement no resolver settled (BR-005-20b–
 *   20e), or a row commit refused. Only the user can settle it: classify it
 *   (BR-005-20), ignore it with a reason (BR-005-20f), or supply what the
 *   refusal names.
 * - `no_rule` — the movement type is not in the map at all (BR-005-19): a fix
 *   has to ship before an import can read it.
 *
 * **Derived, never stored**, so a deploy that teaches the map a type moves the
 * row to `reimport` without a migration. Stamping the map version on each
 * batch (#8) would answer "does the batch predate the rule" directly; without
 * it, the row read again by the current parser (`NeedsAttentionRow.current`)
 * is the honest proxy — and it is also the only one that sees a parser fix,
 * which changes no map version.
 */
export const ATTENTION_RESOLUTIONS = ['reimport', 'decide', 'no_rule'] as const;
export type AttentionResolution = (typeof ATTENTION_RESOLUTIONS)[number];

export function attentionResolutionOf(
  row: Pick<ImportRow, 'classification'>,
  current: NormalizedRecord,
  storedCopyUserModified = false,
): AttentionResolution {
  // A refusal (#117) is a mapped row commit could not apply. What is missing —
  // a purchase before a sale, a credit's cost — is the user's to supply; the
  // batch screen says which. A stored copy the user edited is one no import
  // touches (SPEC-006 BR-006-16, BR-005-19's "untouched"), so a re-import
  // cannot settle it either.
  if (
    row.classification === 'invalid' ||
    storedCopyUserModified ||
    current.kind !== 'transaction'
  ) {
    return 'decide';
  }

  if (isIgnoredMovement(current.b3Type)) return 'reimport';
  // Named rather than mapped (BR-005-18 v4/v5): staged `unclassified` on
  // purpose, and settled at commit only when the evidence is complete.
  if (
    corporateEventMovementOf(current.b3Type) !== null ||
    conversionEvidenceMovementOf(current.b3Type, current) !== null
  ) {
    return 'decide';
  }

  const type = classifyMovement(current.b3Type, current.direction);
  if (type === null) return 'no_rule';
  // `stage-batch.ts`'s own test: a type whose effect depends on price stages
  // `unclassified` when B3 stated none, whatever map version read it.
  return !current.priceStated && PRICE_BEARING_TYPES.has(type) ? 'decide' : 'reimport';
}
