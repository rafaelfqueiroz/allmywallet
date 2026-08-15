import { describe, expect, it, vi } from 'vitest';
import { AppShell } from '@/components/patterns/app-shell';
import { audit, render, screen, userEvent, waitFor, within } from '@/components/test-utils';

const pathname = vi.hoisted(() => ({ current: '/wallets' }));

vi.mock('next/navigation', () => ({
  usePathname: () => pathname.current,
}));

describe('AppShell', () => {
  it('renders one navigation landmark with every destination', () => {
    pathname.current = '/wallets';
    render(<AppShell>conteúdo</AppShell>);

    // Sidebar and drawer share one definition, but only the sidebar is mounted
    // until the drawer is opened.
    const nav = screen.getByRole('navigation', { name: 'Navegação' });
    expect(within(nav).getAllByRole('link')).toHaveLength(4);
  });

  // Styling the active item without aria-current makes the state sighted-only.
  it('marks the current page with aria-current', () => {
    pathname.current = '/wallets';
    render(<AppShell>conteúdo</AppShell>);

    expect(screen.getByRole('link', { name: 'Carteiras' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Importar' })).not.toHaveAttribute('aria-current');
  });

  it('keeps a nested route marked against its section', () => {
    pathname.current = '/wallets/abc-123';
    render(<AppShell>conteúdo</AppShell>);

    expect(screen.getByRole('link', { name: 'Carteiras' })).toHaveAttribute('aria-current', 'page');
  });

  it('does not mark a section whose href is merely a string prefix', () => {
    pathname.current = '/importar-outro';
    render(<AppShell>conteúdo</AppShell>);

    expect(screen.getByRole('link', { name: 'Importar' })).not.toHaveAttribute('aria-current');
  });

  it('offers a skip link so a keyboard user reaches content without the whole menu', () => {
    pathname.current = '/wallets';
    render(<AppShell>conteúdo</AppShell>);

    expect(screen.getByRole('link', { name: 'Pular para o conteúdo' })).toHaveAttribute(
      'href',
      '#conteudo',
    );
  });

  it('collapses and expands the sidebar, reporting the state', async () => {
    pathname.current = '/wallets';
    const user = userEvent.setup();
    render(<AppShell>conteúdo</AppShell>);

    const collapse = screen.getByRole('button', { name: 'Recolher menu lateral' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');

    await user.click(collapse);

    const expand = await screen.findByRole('button', { name: 'Expandir menu lateral' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps nav labels reachable when collapsed to icons', async () => {
    pathname.current = '/wallets';
    const user = userEvent.setup();
    render(<AppShell>conteúdo</AppShell>);

    await user.click(screen.getByRole('button', { name: 'Recolher menu lateral' }));

    // The label goes visually hidden, not away — an icon-only link with no
    // accessible name is unusable with a screen reader.
    expect(screen.getByRole('link', { name: 'Carteiras' })).toBeInTheDocument();
  });

  it('opens the mobile drawer and closes it on navigation', async () => {
    pathname.current = '/wallets';
    const user = userEvent.setup();
    render(<AppShell>conteúdo</AppShell>);

    await user.click(screen.getByRole('button', { name: 'Abrir menu' }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('link', { name: 'Importar' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('has no axe violations', async () => {
    pathname.current = '/wallets';
    const { container } = render(<AppShell>conteúdo</AppShell>);
    expect(await audit(container)).toHaveNoViolations();
  });

  it('has no axe violations with the drawer open', async () => {
    pathname.current = '/wallets';
    const user = userEvent.setup();
    const { baseElement } = render(<AppShell>conteúdo</AppShell>);

    await user.click(screen.getByRole('button', { name: 'Abrir menu' }));
    await screen.findByRole('dialog');

    expect(await audit(baseElement)).toHaveNoViolations();
  });
});
