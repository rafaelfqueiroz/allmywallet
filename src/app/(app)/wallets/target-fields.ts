/**
 * SPEC-017 — how the target editor encodes one percentage per asset in a
 * `FormData`.
 *
 * **A plain module rather than a constant in `actions.ts`, and that is not a
 * style choice.** A `'use server'` file may export *async functions only*; a
 * `export const` beside them makes Next fail the whole module at build time
 * with "the module has no exports at all", which reads as though every action
 * in the file had vanished. `pnpm typecheck` is happy with it — only `pnpm
 * build` catches it.
 *
 * The field name carries the asset id because the form is generated from the
 * wallet: the set of rows is the user's own allocation and changes whenever
 * they file something into the wallet, so a fixed field shape cannot express
 * it.
 */
export const TARGET_FIELD_PREFIX = 'target:';

export function targetFieldName(assetId: string): string {
  return `${TARGET_FIELD_PREFIX}${assetId}`;
}
