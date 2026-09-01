import {
  ChartPie,
  Eye,
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
 * Only routes that exist are listed. `nav.dashboard` has a catalogue entry but
 * no page yet; linking to it would ship a navigation menu whose item 404s,
 * which is worse than a shorter menu. `nav.transactions` graduated out of that
 * category with #9 (SPEC-006) — a user can now reach their ledger.
 * `nav.watch` (SPEC-018, #90) joined the same way — `/watch` exists as of
 * this change.
 */
export type NavItem = {
  readonly href: string;
  readonly labelKey:
    'transactions' | 'wallets' | 'watch' | 'import' | 'reports' | 'settings' | 'privacy';
  readonly icon: LucideIcon;
};

export const NAV_ITEMS: readonly NavItem[] = [
  // BR-006-01: the ledger is the single source of truth everything else is
  // derived from, which is why it leads the menu rather than sitting after
  // the views built on top of it.
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
