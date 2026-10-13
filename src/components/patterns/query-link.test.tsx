import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryLink } from '@/components/patterns/query-link';
import { render, screen } from '@/components/test-utils';

const nav = vi.hoisted(() => ({ search: '', pathname: '/settings/wallets/assign' }));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

beforeEach(() => {
  nav.search = '';
});

/**
 * SPEC-022 BR-022-18 — a row's link opens a form outside the table by naming the
 * row in the URL, and must not drop the sort, page and filter the tables on the
 * page keep in that same URL.
 */
describe('QueryLink', () => {
  it('sets one parameter and keeps every other, so a table does not go back to page 1', () => {
    nav.search = 'pending_page=3&pending_sort=asset%3Adesc';
    render(<QueryLink set={{ resolve: 'abc' }}>Resolver</QueryLink>);
    expect(screen.getByRole('link', { name: 'Resolver' })).toHaveAttribute(
      'href',
      '/settings/wallets/assign?pending_page=3&pending_sort=asset%3Adesc&resolve=abc',
    );
  });

  it('replaces a parameter that is already set', () => {
    nav.search = 'resolve=old';
    render(<QueryLink set={{ resolve: 'new' }}>Resolver</QueryLink>);
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      '/settings/wallets/assign?resolve=new',
    );
  });

  it('drops a parameter, and leaves a bare path when nothing else is left', () => {
    nav.search = 'rule=abc';
    render(<QueryLink drop={['rule']}>Fechar</QueryLink>);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/settings/wallets/assign');
  });

  it('lands on a fragment', () => {
    render(
      <QueryLink set={{ resolve: 'abc' }} hash="resolver">
        Resolver
      </QueryLink>,
    );
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      '/settings/wallets/assign?resolve=abc#resolver',
    );
  });
});
