import {
  ArrowDownUp,
  Binoculars,
  ChartLine,
  LayoutGrid,
  Upload,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

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
  readonly labelKey: 'dashboard' | 'transactions' | 'wallets' | 'watch' | 'import' | 'reports';
  readonly icon: LucideIcon;
};

export const NAV_ITEMS: readonly NavItem[] = [
  /*
   * #98 — the landing screen leads the menu because it is where sign-in puts
   * the user (SPEC-001 BR-001-04) and where they return to; a menu whose first
   * item is not the one the product opens on reads as an accident.
   */
  { href: '/dashboard', labelKey: 'dashboard', icon: LayoutGrid },
  { href: '/wallets', labelKey: 'wallets', icon: Wallet },
  { href: '/reports', labelKey: 'reports', icon: ChartLine },
  { href: '/transactions', labelKey: 'transactions', icon: ArrowDownUp },
  { href: '/import', labelKey: 'import', icon: Upload },
  // SPEC-018. Binoculars rather than an eye: the eye is the masking toggle's
  // (BR-022-24), and one glyph meaning two things in one frame reads as a bug.
  { href: '/watch', labelKey: 'watch', icon: Binoculars },
];
