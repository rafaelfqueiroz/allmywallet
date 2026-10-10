import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Eye, Upload } from 'lucide-react';
import { SubNav } from '@/components/patterns/sub-nav';
import { audit, render, screen, userEvent, within } from '@/components/test-utils';

const nav = vi.hoisted(() => ({ pathname: '/preferences/importar' }));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
}));

const items = [
  { href: '/preferences', label: 'Carteiras', exact: true },
  { href: '/preferences/importar', label: 'Importar', icon: Upload },
  { href: '/preferences/observar', label: 'Observar preços', icon: Eye },
] as const;

function Sections() {
  return <SubNav label="Seções de Configurações" items={items} />;
}

beforeEach(() => {
  nav.pathname = '/preferences/importar';
});

describe('SubNav', () => {
  it('is a named navigation of links', () => {
    render(<Sections />);
    const navigation = screen.getByRole('navigation', { name: 'Seções de Configurações' });
    expect(within(navigation).getAllByRole('link')).toHaveLength(3);
  });

  it('marks only the current section with aria-current', () => {
    render(<Sections />);
    expect(screen.getByRole('link', { name: 'Importar' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Carteiras' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Observar preços' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('keeps a nested route marked against its section', () => {
    nav.pathname = '/preferences/importar/historico';
    render(<Sections />);
    expect(screen.getByRole('link', { name: 'Importar' })).toHaveAttribute('aria-current', 'page');
  });

  it('does not mark a section whose href is merely a string prefix', () => {
    nav.pathname = '/preferences/importar-outro';
    render(<Sections />);
    expect(screen.getByRole('link', { name: 'Importar' })).not.toHaveAttribute('aria-current');
  });

  // BR-022-33 — the same treatment as the sidebar: a fill, with the ring apart.
  it('fills the current item and gives every item a focus ring', () => {
    render(<Sections />);
    const current = screen.getByRole('link', { name: 'Importar' }).className;
    const other = screen.getByRole('link', { name: 'Carteiras' }).className;

    expect(current).toContain('bg-nav-active');
    expect(current).toContain('text-nav-active-foreground');
    expect(other).not.toContain('bg-nav-active');
    expect(other).toContain('hover:bg-accent');
    expect(current).toContain('focus-visible:ring-ring');
    expect(other).toContain('focus-visible:ring-ring');
  });

  it('hides its icons from assistive technology', () => {
    const { container } = render(<Sections />);
    for (const icon of container.querySelectorAll('svg')) {
      expect(icon).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('is operable from the keyboard alone', async () => {
    const user = userEvent.setup();
    render(<Sections />);
    await user.tab();
    expect(screen.getByRole('link', { name: 'Carteiras' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Importar' })).toHaveFocus();
  });

  it('has no axe violations', async () => {
    const { container } = render(<Sections />);
    expect(await audit(container)).toHaveNoViolations();
  });
});
