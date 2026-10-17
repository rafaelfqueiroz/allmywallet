/**
 * AR-45: pt-BR is the only locale in v1. The catalogue exists so SPEC-016
 * BR-016-17's vocabulary requirement is checkable — not because a second
 * language is planned. There is therefore no locale segment in the URL and no
 * negotiation.
 *
 * Its own module, with no imports, so `format.ts` can reach Client Components
 * (the charts' axis formatters, SPEC-022 BR-022-38) without `request.ts`
 * pulling `next-intl/server` and the whole message catalogue in behind it.
 */
export const DEFAULT_LOCALE = 'pt-BR';
export const TIME_ZONE = 'America/Sao_Paulo';
