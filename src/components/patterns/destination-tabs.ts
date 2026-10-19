import type { RouteTab } from '@/components/patterns/route-tabs';
import { IMPORT_HISTORY_PATH, IMPORT_PARAMETERS_PATH, IMPORT_SEND_PATH } from '@/lib/import-paths';
import { WATCH_PARAMETERS_PATH, WATCH_RULES_PATH } from '@/lib/watch-paths';

/**
 * SPEC-022 BR-022-02/03/05/16 — every destination's tabs, and Configurações'
 * sections and their tasks, written once. The frames render them as
 * `RouteTabs` (`routeTabs`), and the top bar's breadcrumb names the current
 * one (BR-022-09, `breadcrumbs.ts`), so a tab added here is in both and a tab
 * cannot be lit under one name and named in the crumb with another (#254).
 *
 * `labelKey` is a full `pt-BR.json` key rather than text (AR-44): the frames
 * are Server Components and the breadcrumb is a Client Component, and each
 * translates it with its own `t`. Plain strings and no `next/*` import.
 */
export type TabDefinition = {
  readonly href: string;
  /** A full message key, e.g. `portfolio.tabs.composicao`. */
  readonly labelKey: string;
  /** DS-52 — the root of its siblings, matched exactly. */
  readonly exact?: true;
  /** DS-64 — further paths this tab stays current on. */
  readonly alsoActiveOn?: readonly string[];
};

/** One of Configurações' sections: a main tab with a pill row of tasks (BR-022-16). */
export type SectionDefinition = TabDefinition & {
  readonly tasks: readonly TabDefinition[];
  /**
   * SPEC-022 BR-022-09 / DL-022-27 — the task a page under the section that is
   * not itself a task (one wallet, one batch) belongs to. The breadcrumb ends
   * there, which keeps it a function of the path alone: the top bar is
   * rendered by the layout, which would otherwise load the wallet or the batch
   * to name it. It is where that page's way back leads.
   */
  readonly detailsBelongTo?: string;
};

/** BR-022-02 — Portfólio. Patrimônio is the destination's root. */
export const PORTFOLIO_TABS: readonly TabDefinition[] = [
  { href: '/portfolio', labelKey: 'portfolio.tabs.patrimonio', exact: true },
  { href: '/portfolio/composition', labelKey: 'portfolio.tabs.composicao' },
  { href: '/portfolio/wallets', labelKey: 'portfolio.tabs.carteiras' },
  { href: '/portfolio/goals', labelKey: 'portfolio.tabs.metas' },
];

/** BR-022-03 — Relatórios. Evolução patrimonial is the destination's root. */
export const REPORTS_TABS: readonly TabDefinition[] = [
  { href: '/reports', labelKey: 'reports.links.patrimonio', exact: true },
  { href: '/reports/performance', labelKey: 'reports.links.performance' },
  { href: '/reports/earnings', labelKey: 'reports.links.proventos' },
];

/** BR-022-05/16 — Configurações › Carteiras. "Nova carteira" is part of Minhas carteiras. */
export const WALLETS_SECTION: SectionDefinition = {
  href: '/settings/wallets',
  labelKey: 'settings.sections.wallets',
  tasks: [
    {
      href: '/settings/wallets',
      labelKey: 'wallets.tabs.mine',
      exact: true,
      alsoActiveOn: ['/settings/wallets/new'],
    },
    { href: '/settings/wallets/assign', labelKey: 'wallets.tabs.assign' },
    { href: '/settings/wallets/parameters', labelKey: 'wallets.tabs.parameters' },
  ],
  detailsBelongTo: '/settings/wallets',
};

/** BR-022-05/16, DL-022-12 — Configurações › Importar. A batch belongs to Histórico. */
export const IMPORT_SECTION: SectionDefinition = {
  href: IMPORT_SEND_PATH,
  labelKey: 'settings.sections.import',
  tasks: [
    { href: IMPORT_SEND_PATH, labelKey: 'import.tabs.send', exact: true },
    { href: IMPORT_HISTORY_PATH, labelKey: 'import.tabs.history' },
    { href: IMPORT_PARAMETERS_PATH, labelKey: 'import.tabs.parameters' },
  ],
  detailsBelongTo: IMPORT_HISTORY_PATH,
};

/** BR-022-05/16 — Configurações › Observar preços. */
export const WATCH_SECTION: SectionDefinition = {
  href: WATCH_RULES_PATH,
  labelKey: 'settings.sections.watch',
  tasks: [
    { href: WATCH_RULES_PATH, labelKey: 'watch.tabs.rules', exact: true },
    { href: WATCH_PARAMETERS_PATH, labelKey: 'watch.tabs.parameters' },
  ],
};

/** BR-022-05 — Configurações' three sections, in its order. */
export const SETTINGS_SECTIONS: readonly SectionDefinition[] = [
  WALLETS_SECTION,
  IMPORT_SECTION,
  WATCH_SECTION,
];

/**
 * The tabs of each destination that has them, by the destination's
 * `nav-items.ts` href. A destination absent here — Dashboard, Transações — is
 * one task.
 */
export const DESTINATION_TABS: Readonly<
  Record<string, readonly (TabDefinition | SectionDefinition)[]>
> = {
  '/portfolio': PORTFOLIO_TABS,
  '/reports': REPORTS_TABS,
  '/settings': SETTINGS_SECTIONS,
};

/** The definitions as `RouteTabs` takes them, translated with the caller's `t`. */
export function routeTabs(tabs: readonly TabDefinition[], t: (key: string) => string): RouteTab[] {
  return tabs.map(({ href, labelKey, exact, alsoActiveOn }) => ({
    href,
    label: t(labelKey),
    ...(exact ? { exact } : {}),
    ...(alsoActiveOn ? { alsoActiveOn } : {}),
  }));
}
