/**
 * SPEC-022 BR-022-05/07 (#212) — where Configurações › Observar preços lives,
 * written once. The rules moved from `/watch` (BR-022-08 redirects the old
 * path, see `src/lib/legacy-redirects.ts`), and every link to a rule — the
 * Painel's watch-state card, the opportunity e-mail, the revalidation after a
 * rule changes — is built here, so the next move is one edit.
 *
 * In `lib/` rather than beside the route, unlike `(app)/import/paths.ts`: the
 * e-mail adapters link to a rule too, and `adapters/` may not import from
 * `app/` (eslint `import/no-restricted-paths`). Plain strings and no `next/*`
 * import, so a Client Component can use it as well.
 */
export const WATCH_RULES_PATH = '/settings/watch';
export const WATCH_PARAMETERS_PATH = '/settings/watch/parameters';

/** The element id a rule's row carries on the rules tab — the target of "Ver regra". */
export function watchRuleAnchor(assetId: string): string {
  return `regra-${assetId}`;
}

/** One rule, on the rules tab (BR-022-07: "each linking to its rule"). */
export function watchRulePath(assetId: string): string {
  return `${WATCH_RULES_PATH}#${watchRuleAnchor(assetId)}`;
}
