import { describe, expect, it } from 'vitest';
import { PORTFOLIO_TABS, WALLETS_SECTION, routeTabs } from '@/components/patterns/destination-tabs';

const t = (key: string) => `«${key}»`;

// DS-52/DS-64 — the matching flags must survive the trip into `RouteTabs`, or
// a root tab stays lit under its siblings.
describe('routeTabs', () => {
  it('translates each label with the caller’s t and keeps the matching flags', () => {
    expect(routeTabs(PORTFOLIO_TABS, t).slice(0, 2)).toEqual([
      { href: '/portfolio', label: '«portfolio.tabs.patrimonio»', exact: true },
      { href: '/portfolio/composition', label: '«portfolio.tabs.composicao»' },
    ]);
    expect(routeTabs(WALLETS_SECTION.tasks, t)[0]).toEqual({
      href: '/settings/wallets',
      label: '«wallets.tabs.mine»',
      exact: true,
      alsoActiveOn: ['/settings/wallets/new'],
    });
  });
});
