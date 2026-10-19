/**
 * SPEC-022 BR-022-05/16 (#211) — where Configurações › Importar lives, written
 * once. Importar moved from `/import` (BR-022-08 redirects the old paths, see
 * `src/lib/legacy-redirects.ts`), and every screen that links to an import —
 * the Dashboard, Transações' provenance link, the onboarding guide, the post-upload
 * redirect — builds its URL here, so the next move is one edit.
 *
 * Plain strings and no `next/*` import, so a Client Component can use it too.
 * In `lib/` beside `watch-paths.ts` since #254: the shell's breadcrumb
 * (`components/patterns/destination-tabs.ts`) is built from these paths, and
 * nothing below `app/` imports from it.
 */
export const IMPORT_SEND_PATH = '/settings/import';
export const IMPORT_HISTORY_PATH = '/settings/import/history';
export const IMPORT_PARAMETERS_PATH = '/settings/import/parameters';

/** The B3 export guide on the Enviar tab — the staleness prompt's "see the steps". */
export const IMPORT_GUIDE_ANCHOR = 'import-guide';

export function importBatchPath(batchId: string): string {
  return `/settings/import/${batchId}`;
}
