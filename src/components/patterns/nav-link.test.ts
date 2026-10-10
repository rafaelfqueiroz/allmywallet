import { describe, expect, it } from 'vitest';
import { hrefWithParams, isPathActive, navItemClassName } from '@/components/patterns/nav-link';

describe('isPathActive', () => {
  it('matches the page itself', () => {
    expect(isPathActive('/wallets', '/wallets')).toBe(true);
  });

  it('matches a section the page is inside, on a path boundary', () => {
    expect(isPathActive('/wallets/abc', '/wallets')).toBe(true);
    expect(isPathActive('/importar-outro', '/import')).toBe(false);
  });

  it('can be told to match the root only', () => {
    expect(isPathActive('/reports', '/reports', true)).toBe(true);
    expect(isPathActive('/reports/patrimonio', '/reports', true)).toBe(false);
  });
});

describe('navItemClassName', () => {
  // BR-022-33 — the current item is a fill, never the focus ring's token.
  it('fills the active item with nav-active and keeps focus as a ring', () => {
    const active = navItemClassName(true);
    expect(active).toContain('bg-nav-active');
    expect(active).toContain('text-nav-active-foreground');
    expect(active).toContain('focus-visible:ring-ring');
    expect(active).not.toContain('hover:bg-accent');
  });

  it('hovers an inactive item with the neutral accent', () => {
    const inactive = navItemClassName(false);
    expect(inactive).toContain('hover:bg-accent');
    expect(inactive).not.toContain('bg-nav-active');
  });
});

describe('hrefWithParams', () => {
  const current = new URLSearchParams('wallet=abc&page=4&period=12m');

  it('carries nothing by default', () => {
    expect(hrefWithParams('/reports/patrimonio', current, undefined)).toBe('/reports/patrimonio');
    expect(hrefWithParams('/reports/patrimonio', current, [])).toBe('/reports/patrimonio');
  });

  it('copies only the named parameters', () => {
    expect(hrefWithParams('/reports/patrimonio', current, ['wallet'])).toBe(
      '/reports/patrimonio?wallet=abc',
    );
    expect(hrefWithParams('/reports/patrimonio', current, ['wallet', 'period'])).toBe(
      '/reports/patrimonio?wallet=abc&period=12m',
    );
  });

  it('skips a parameter the current URL does not have', () => {
    expect(hrefWithParams('/reports', new URLSearchParams(), ['wallet'])).toBe('/reports');
  });

  it('encodes values', () => {
    expect(hrefWithParams('/r', new URLSearchParams({ wallet: 'a b&c' }), ['wallet'])).toBe(
      '/r?wallet=a+b%26c',
    );
  });

  it('appends to an href that already has a query', () => {
    expect(hrefWithParams('/r?x=1', current, ['wallet'])).toBe('/r?x=1&wallet=abc');
  });
});
