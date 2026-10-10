/**
 * SPEC-022 BR-022-08 — **every URL that existed before M10 keeps working.**
 *
 * E-mails already sent (SPEC-018 notifications, SPEC-005 reminders) and
 * bookmarks link to the old paths, and nothing can update them. So when a
 * screen moves, its old path answers with a **permanent** redirect (308) to the
 * new one, for as long as the product runs.
 *
 * One table, read by `next.config.ts` (`redirects()`), so the redirects are
 * resolved by the router before any page renders and need no page of their
 * own. **Each destination issue adds its own rows in the PR that moves the
 * route** (#208 Portfólio, #209 Relatórios, #210–#212 Configurações), together
 * with an `example` — a concrete old URL and where it must land. The E2E
 * journey `tests/e2e/redirects.spec.ts` requests every example and checks the
 * answer, and `legacy-redirects.test.ts` holds the table's invariants, so a row
 * cannot be added without both checks applying to it.
 *
 * `source`/`destination` use Next's path syntax (`/wallets/:walletId/balance`,
 * `/portfolio/wallets?wallet=:walletId`). Next carries the request's own query
 * string across, so `?periodo=…` on an old report link survives the move.
 */
export interface LegacyRedirect {
  readonly source: string;
  readonly destination: string;
  /** The board issue that moved the route — the row's provenance. */
  readonly issue: number;
  /** A concrete request and the URL it must land on, for the E2E check. */
  readonly example: { readonly from: string; readonly to: string };
}

export const LEGACY_REDIRECTS: readonly LegacyRedirect[] = [];

/** The shape `next.config.ts`'s `redirects()` returns. */
export interface NextRedirect {
  readonly source: string;
  readonly destination: string;
  readonly permanent: true;
}

/**
 * Always `permanent: true`: a moved screen is not coming back, and a
 * temporary redirect would keep every old link pointing at the old path in
 * caches and bookmarks forever.
 */
export function toNextRedirects(rows: readonly LegacyRedirect[]): NextRedirect[] {
  return rows.map(({ source, destination }) => ({ source, destination, permanent: true }));
}
