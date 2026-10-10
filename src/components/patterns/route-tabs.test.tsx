import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RouteTabs } from '@/components/patterns/route-tabs';
import { audit, render, screen, userEvent, within } from '@/components/test-utils';

const nav = vi.hoisted(() => ({ pathname: '/reports/patrimonio', search: '' }));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const tabs = [
  { href: '/reports', label: 'Visão geral', exact: true },
  { href: '/reports/patrimonio', label: 'Patrimônio' },
  { href: '/reports/composition', label: 'Composição' },
] as const;

function Tabs({ preserveParams }: { preserveParams?: readonly string[] }) {
  return (
    <RouteTabs label="Relatórios" tabs={tabs} {...(preserveParams ? { preserveParams } : {})} />
  );
}

beforeEach(() => {
  nav.pathname = '/reports/patrimonio';
  nav.search = '';
});

describe('RouteTabs', () => {
  it('is a named navigation of links, one URL per tab', () => {
    render(<Tabs />);
    const nav = screen.getByRole('navigation', { name: 'Relatórios' });
    const links = within(nav).getAllByRole('link');

    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/reports',
      '/reports/patrimonio',
      '/reports/composition',
    ]);
    // Navigation, not the ARIA tabs pattern — see the component's doc comment.
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('marks only the active tab with aria-current', () => {
    render(<Tabs />);
    expect(screen.getByRole('link', { name: 'Patrimônio' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Visão geral' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Composição' })).not.toHaveAttribute('aria-current');
  });

  it('matches an exact tab only on its own path', () => {
    render(<Tabs />);
    // `/reports` is the root of the others and must not light up beside them.
    expect(screen.getByRole('link', { name: 'Visão geral' })).not.toHaveAttribute('aria-current');
  });

  it('lights the overview tab on the overview', () => {
    nav.pathname = '/reports';
    render(<Tabs />);
    expect(screen.getByRole('link', { name: 'Visão geral' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Patrimônio' })).not.toHaveAttribute('aria-current');
  });

  it('keeps a nested route marked against its tab', () => {
    nav.pathname = '/reports/composition/detalhe';
    render(<Tabs />);
    expect(screen.getByRole('link', { name: 'Composição' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('carries nothing across tabs by default', () => {
    nav.search = 'wallet=abc&period=12m';
    render(<Tabs />);
    expect(screen.getByRole('link', { name: 'Composição' })).toHaveAttribute(
      'href',
      '/reports/composition',
    );
  });

  it('carries the listed parameters onto every tab, and only those', () => {
    nav.search = 'wallet=abc&period=12m&page=3';
    render(<Tabs preserveParams={['wallet']} />);

    for (const link of screen.getAllByRole('link')) {
      const url = new URL(link.getAttribute('href') ?? '', 'http://localhost');
      expect(url.searchParams.get('wallet')).toBe('abc');
      expect(url.searchParams.has('period')).toBe(false);
      expect(url.searchParams.has('page')).toBe(false);
    }
  });

  it('writes no parameter the current URL does not have', () => {
    render(<Tabs preserveParams={['wallet']} />);
    expect(screen.getByRole('link', { name: 'Composição' })).toHaveAttribute(
      'href',
      '/reports/composition',
    );
  });

  it('gives the active and the focused tab different treatments', () => {
    render(<Tabs />);
    const active = screen.getByRole('link', { name: 'Patrimônio' }).className;
    const inactive = screen.getByRole('link', { name: 'Composição' }).className;

    // BR-022-33 / DS-48 — active is an underline in `primary`, focus a ring.
    expect(active).toContain('border-primary');
    expect(inactive).not.toContain('border-primary');
    expect(active).toContain('focus-visible:ring-ring');
    expect(inactive).toContain('focus-visible:ring-ring');
    expect(inactive).toContain('hover:bg-accent');
  });

  it('is operable from the keyboard alone', async () => {
    const user = userEvent.setup();
    render(<Tabs />);

    await user.tab();
    expect(screen.getByRole('link', { name: 'Visão geral' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Patrimônio' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Composição' })).toHaveFocus();
  });

  it('has no axe violations', async () => {
    const { container } = render(<Tabs preserveParams={['wallet']} />);
    expect(await audit(container)).toHaveNoViolations();
  });
});
