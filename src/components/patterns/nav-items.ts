import {
  ArrowDownUp,
  Binoculars,
  ChartLine,
  ChartPie,
  LayoutGrid,
  Upload,
  type LucideIcon,
} from 'lucide-react';
import { PARAM } from '@/lib/report-url-state';
import { hrefWithParams, isPathActive } from '@/components/patterns/nav-link';

/**
 * The application's destinations, in one place, so the sidebar and the mobile
 * drawer cannot disagree about what exists (DL-11).
 *
 * `labelKey` indexes the existing `nav.*` catalogue rather than carrying text —
 * AR-44 applies to a nav item as much as to a button.
 *
 * **Only routes that exist are listed (DS-26)** — a navigation menu whose item
 * 404s is worse than a shorter menu. SPEC-022 BR-022-01's five destinations
 * (Painel, Portfólio, Relatórios, Transações, Configurações) therefore arrive
 * one at a time, each with the issue that makes its route real (#208 Portfólio,
 * #210–#212 Configurações), and the items they absorb leave in the same
 * change. Until then the order already follows BR-022-01: what is held, what
 * it did over time, the ledger, then setup.
 *
 * Preferências and Privacidade left this list with #205: they belong to the
 * person rather than to a feature, so they live in the account menu
 * (BR-022-10). Privacidade stays one click from every screen there, which is
 * what SPEC-004 BR-004-06/09's self-service rights need.
 */
export type NavItem = {
  readonly href: string;
  readonly labelKey: 'dashboard' | 'portfolio' | 'transactions' | 'watch' | 'import' | 'reports';
  readonly icon: LucideIcon;
  /**
   * SPEC-022 BR-022-17 — the destination reads the shared scope selector's
   * `wallet` parameter. Moving between two such destinations carries it.
   */
  readonly sharesScope?: true;
};

export const NAV_ITEMS: readonly NavItem[] = [
  /*
   * #98 — the landing screen leads the menu because it is where sign-in puts
   * the user (SPEC-001 BR-001-04) and where they return to; a menu whose first
   * item is not the one the product opens on reads as an accident.
   */
  { href: '/dashboard', labelKey: 'dashboard', icon: LayoutGrid },
  /*
   * SPEC-022 BR-022-01/02 (#208) — Portfólio replaces Carteiras (DS-26): the
   * wallets' analysis is its Carteiras tab, and `/wallets` redirects there.
   * The prototype's pie, because the destination answers "what do I hold".
   */
  { href: '/portfolio', labelKey: 'portfolio', icon: ChartPie, sharesScope: true },
  // SPEC-022 BR-022-03 (#209) — Relatórios' root is its first tab, Evolução
  // patrimonial, so the item needs no redirect hop.
  { href: '/reports', labelKey: 'reports', icon: ChartLine, sharesScope: true },
  { href: '/transactions', labelKey: 'transactions', icon: ArrowDownUp },
  { href: '/import', labelKey: 'import', icon: Upload },
  // SPEC-018. Binoculars rather than an eye: the eye is the masking toggle's
  // (BR-022-24), and one glyph meaning two things in one frame reads as a bug.
  { href: '/watch', labelKey: 'watch', icon: Binoculars },
];

/**
 * SPEC-022 BR-022-17 — an item's href from where the user is now.
 *
 * Portfólio and Relatórios share one scope selector, so a wallet chosen in one
 * is still the scope in the other (BR-011-11, #209). The scope is carried only
 * **between** those two: Transações also reads a `wallet` parameter, but as a
 * filter of its own, and a filter leaking into a destination as its scope — or
 * a scope leaking into the ledger as a filter — is a view the user never chose.
 */
export function navHref(
  item: NavItem,
  pathname: string,
  current: { get(name: string): string | null },
): string {
  if (!item.sharesScope) return item.href;
  const here = NAV_ITEMS.find((candidate) => isPathActive(pathname, candidate.href));
  if (!here?.sharesScope) return item.href;
  return hrefWithParams(item.href, current, [PARAM.wallet]);
}
