import { ChartPie, Settings, Upload, Wallet, type LucideIcon } from 'lucide-react';

/**
 * The application's destinations, in one place, so the sidebar and the mobile
 * drawer cannot disagree about what exists (DL-11).
 *
 * `labelKey` indexes the existing `nav.*` catalogue rather than carrying text —
 * AR-44 applies to a nav item as much as to a button.
 *
 * Only routes that exist are listed. `nav.dashboard` and `nav.transactions`
 * have catalogue entries but no pages yet; linking to them would ship a
 * navigation menu whose items 404, which is worse than a shorter menu.
 */
export type NavItem = {
  readonly href: string;
  readonly labelKey: 'wallets' | 'import' | 'reports' | 'settings';
  readonly icon: LucideIcon;
};

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/wallets', labelKey: 'wallets', icon: Wallet },
  { href: '/import', labelKey: 'import', icon: Upload },
  { href: '/reports', labelKey: 'reports', icon: ChartPie },
  { href: '/preferences', labelKey: 'settings', icon: Settings },
];
