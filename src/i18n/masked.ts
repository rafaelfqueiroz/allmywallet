/**
 * SPEC-022 BR-022-26 — what a hidden amount renders as, whatever its magnitude,
 * so the number of digits does not leak. The space is the same no-break space
 * `Intl` puts after `R$`, so the placeholder never wraps where a real figure
 * would not.
 *
 * Its own module, with no imports, because Client Components need it — the
 * charts and the holdings table — and `format.ts` pulls the request config and
 * the whole message catalogue in behind it.
 */
export const MASKED_CURRENCY = 'R$ ••••••';
