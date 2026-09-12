import {
  ChartPie,
  Eye,
  LayoutDashboard,
  Receipt,
  Settings,
  ShieldCheck,
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
 * Only routes that exist are listed. `nav.transactions` graduated out of that
 * category with #9 (SPEC-006) — a user can now reach their ledger.
 * `nav.watch` (SPEC-018, #90) joined the same way, and `nav.dashboard` with
 * #98: it held a catalogue entry and no page for seven milestones, which is
 * why it was kept out of this list — a navigation menu whose item 404s is
 * worse than a shorter menu.
 */
export type NavItem = {
  readonly href: string;
  readonly labelKey:
    | 'dashboard'
    | 'transactions'
    | 'wallets'
    | 'watch'
    | 'import'
    | 'reports'
    | 'settings'
    | 'privacy';
  readonly icon: LucideIcon;
};

export const NAV_ITEMS: readonly NavItem[] = [
  /*
   * #98 — the landing screen leads the menu because it is where sign-in puts
   * the user (SPEC-001 BR-001-04) and where they return to; a menu whose first
   * item is not the one the product opens on reads as an accident.
   *
   * It sits **above** the ledger despite BR-006-01 making the ledger the single
   * source of truth everything else derives from. That rule is about where data
   * comes from, not about what a user opens first.
   */
  { href: '/dashboard', labelKey: 'dashboard', icon: LayoutDashboard },
  { href: '/transactions', labelKey: 'transactions', icon: Receipt },
  { href: '/wallets', labelKey: 'wallets', icon: Wallet },
  // SPEC-018 — rules exist only on held assets (BR-018-01), so this sits
  // beside wallets rather than beside reports: it watches the same holdings,
  // not a derived view of them.
  { href: '/watch', labelKey: 'watch', icon: Eye },
  { href: '/import', labelKey: 'import', icon: Upload },
  { href: '/reports', labelKey: 'reports', icon: ChartPie },
  { href: '/preferences', labelKey: 'settings', icon: Settings },
  // SPEC-004 BR-004-06/09: export and deletion are *self-service* rights, and
  // a right the user cannot find is not self-service. It gets its own
  // destination rather than a link buried inside preferences.
  { href: '/privacy', labelKey: 'privacy', icon: ShieldCheck },
];
