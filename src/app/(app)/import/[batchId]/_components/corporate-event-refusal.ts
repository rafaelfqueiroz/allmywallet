import type { CorporateEventRefusal } from '@/core/ingestion/corporate-event-resolution';

/**
 * SPEC-005 BR-005-20b (#113 PR-B) — the `import.corporateEvent.refusal.*`
 * catalogue key for one refusal.
 *
 * **Deliberately no `default` case.** `CorporateEventRefusal` is
 * `RatioRefusal | FractionRefusal` — a union either of the two files that
 * declare it can grow. The function's return type is `string`, not
 * `string | undefined`, so a refusal this switch does not name leaves a code
 * path with no return and fails `tsc`, not a missing message discovered on
 * screen. `no_basis` and `conflicts_with_ledger` are members of both unions;
 * TypeScript collapses them to one case each here.
 */
export function corporateEventRefusalKey(refusal: CorporateEventRefusal): string {
  switch (refusal) {
    case 'no_basis':
      return 'no_basis';
    case 'no_factor':
      return 'no_factor';
    case 'ambiguous_factor':
      return 'ambiguous_factor';
    case 'disagrees':
      return 'disagrees';
    case 'not_representable':
      return 'not_representable';
    case 'combined_same_day':
      return 'combined_same_day';
    case 'blocked':
      return 'blocked';
    case 'conflicts_with_ledger':
      return 'conflicts_with_ledger';
    case 'no_origin':
      return 'no_origin';
    case 'ambiguous_origin':
      return 'ambiguous_origin';
    case 'origin_unresolved':
      return 'origin_unresolved';
    case 'no_pair':
      return 'no_pair';
    case 'ambiguous_pair':
      return 'ambiguous_pair';
    case 'no_price':
      return 'no_price';
    case 'partner_conflict':
      return 'partner_conflict';
    case 'partner_unresolved':
      return 'partner_unresolved';
  }
}
