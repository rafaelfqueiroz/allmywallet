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

export const LEGACY_REDIRECTS: readonly LegacyRedirect[] = [
  /*
   * #208 — Portfólio (BR-022-02). Wallet analysis, balancing and goals are
   * Portfólio tabs, with the wallet carried as the shared scope parameter
   * (BR-022-17); Composição is current state, so it leaves Relatórios.
   * `/wallets/:walletId` itself is wallet setup and moved with #210, below.
   */
  {
    source: '/wallets',
    destination: '/portfolio/wallets',
    issue: 208,
    example: { from: '/wallets', to: '/portfolio/wallets' },
  },
  {
    source: '/wallets/:walletId/balance',
    destination: '/portfolio/wallets?wallet=:walletId',
    issue: 208,
    example: {
      from: '/wallets/7b0c2c5e-1f1a-4c8e-9a51-3f6d2b8e4a10/balance',
      to: '/portfolio/wallets?wallet=7b0c2c5e-1f1a-4c8e-9a51-3f6d2b8e4a10',
    },
  },
  {
    source: '/wallets/:walletId/goals',
    destination: '/portfolio/goals?wallet=:walletId',
    issue: 208,
    example: {
      from: '/wallets/7b0c2c5e-1f1a-4c8e-9a51-3f6d2b8e4a10/goals?year=2025',
      to: '/portfolio/goals?year=2025&wallet=7b0c2c5e-1f1a-4c8e-9a51-3f6d2b8e4a10',
    },
  },
  {
    source: '/reports/composition',
    destination: '/portfolio/composition',
    issue: 208,
    example: {
      from: '/reports/composition?grouping=sector',
      to: '/portfolio/composition?grouping=sector',
    },
  },
  /*
   * #209 — Relatórios (BR-022-03). Evolução patrimonial is the destination's
   * first tab and so its root, `/reports` — the slug #205 proposed,
   * `/reports/value-history`, would have made the menu item itself a
   * redirect. Visão geral left with #208, so `/reports` needs no row; the
   * query string carries period, scope and grouping across.
   */
  {
    source: '/reports/patrimonio',
    destination: '/reports',
    issue: 209,
    example: {
      from: '/reports/patrimonio?period=12m',
      to: '/reports?period=12m',
    },
  },
  /*
   * #210 — Configurações › Carteiras (BR-022-05). A wallet's setup page is
   * `/settings/wallets/:walletId`; the assignment queue, which #208 had put
   * under Portfólio › Carteiras › Configurar, is its "Atribuir ativos" tab.
   * E-mails and the Dashboard's "Distribuir" items linked to both.
   */
  {
    source: '/wallets/:walletId',
    destination: '/settings/wallets/:walletId',
    issue: 210,
    example: {
      from: '/wallets/7b0c2c5e-1f1a-4c8e-9a51-3f6d2b8e4a10',
      to: '/settings/wallets/7b0c2c5e-1f1a-4c8e-9a51-3f6d2b8e4a10',
    },
  },
  {
    source: '/portfolio/wallets/setup',
    destination: '/settings/wallets/assign',
    issue: 210,
    example: { from: '/portfolio/wallets/setup', to: '/settings/wallets/assign' },
  },
  /*
   * #211 — Configurações › Importar (BR-022-05/16). `/import` was upload and
   * history on one page; it lands on Enviar, the tab that answers "import a
   * file", which links to Histórico. A batch keeps its id. The Dashboard, the
   * onboarding guide and Transações' provenance link pointed at both.
   */
  {
    source: '/import',
    destination: '/settings/import',
    issue: 211,
    example: { from: '/import', to: '/settings/import' },
  },
  {
    source: '/import/:batchId',
    destination: '/settings/import/:batchId',
    issue: 211,
    example: {
      from: '/import/7b0c2c5e-1f1a-4c8e-9a51-3f6d2b8e4a10',
      to: '/settings/import/7b0c2c5e-1f1a-4c8e-9a51-3f6d2b8e4a10',
    },
  },
  /*
   * #212 — Configurações › Observar preços (BR-022-05). `/watch` was the rules
   * and the e-mail cooldown on one page; it lands on Regras, and the cooldown
   * is the section's Parâmetros tab. Bookmarks and the sidebar pointed here.
   */
  {
    source: '/watch',
    destination: '/settings/watch',
    issue: 212,
    example: { from: '/watch', to: '/settings/watch' },
  },
];

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
