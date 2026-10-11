import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, navHref, type NavItem } from '@/components/patterns/nav-items';

const item = (href: string): NavItem => {
  const found = NAV_ITEMS.find((candidate) => candidate.href === href);
  if (found === undefined) throw new Error(`no nav item ${href}`);
  return found;
};

const params = (query: string) => new URLSearchParams(query);

describe('navHref — SPEC-022 BR-022-17: the scope shared by Portfólio and Relatórios', () => {
  it('carries the wallet from Portfólio to Relatórios and back', () => {
    expect(navHref(item('/reports'), '/portfolio/composition', params('wallet=abc'))).toBe(
      '/reports?wallet=abc',
    );
    expect(navHref(item('/portfolio'), '/reports/earnings', params('wallet=abc'))).toBe(
      '/portfolio?wallet=abc',
    );
  });

  it('carries only the scope, never a tab’s own filters', () => {
    expect(
      navHref(item('/portfolio'), '/reports', params('wallet=abc&period=12m&grouping=sector')),
    ).toBe('/portfolio?wallet=abc');
  });

  it('does not turn the ledger’s wallet filter into a scope, nor the reverse', () => {
    expect(navHref(item('/reports'), '/transactions', params('wallet=abc'))).toBe('/reports');
    expect(navHref(item('/transactions'), '/reports', params('wallet=abc'))).toBe('/transactions');
  });

  it('writes a plain href when there is no scope to carry', () => {
    expect(navHref(item('/reports'), '/portfolio', params(''))).toBe('/reports');
    expect(navHref(item('/dashboard'), '/portfolio', params('wallet=abc'))).toBe('/dashboard');
  });
});
