import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScopeSelector } from '@/components/patterns/scope-selector';
import { PARAM } from '@/lib/report-url-state';
import { audit, render, screen, userEvent, waitFor, within } from '@/components/test-utils';

const nav = vi.hoisted(() => ({ pathname: '/reports', search: '', push: vi.fn() }));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: nav.push }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const wallets = [
  { walletId: 'w-aposentadoria', name: 'Aposentadoria' },
  { walletId: 'w-educacao', name: 'Educação' },
];

beforeEach(() => {
  nav.pathname = '/reports';
  nav.search = '';
  nav.push.mockClear();
});

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: /Escopo/ }));
  return screen.findByRole('menu');
};

describe('ScopeSelector', () => {
  it('shows "all wallets" as the scope when the URL names none', () => {
    render(<ScopeSelector wallets={wallets} />);
    expect(screen.getByRole('button', { name: 'Escopo Todas as carteiras' })).toBeInTheDocument();
  });

  it('shows the selected wallet’s name when the URL names one', () => {
    nav.search = `${PARAM.wallet}=w-educacao`;
    render(<ScopeSelector wallets={wallets} />);
    expect(screen.getByRole('button', { name: 'Escopo Educação' })).toBeInTheDocument();
  });

  it('lists "all wallets" first, then each wallet, as one radio group', async () => {
    const user = userEvent.setup();
    render(<ScopeSelector wallets={wallets} />);
    const menu = await open(user);

    expect(
      within(menu)
        .getAllByRole('menuitemradio')
        .map((item) => item.textContent),
    ).toEqual(['Todas as carteiras', 'Aposentadoria', 'Educação']);
  });

  it('checks the current scope', async () => {
    const user = userEvent.setup();
    nav.search = `${PARAM.wallet}=w-educacao`;
    render(<ScopeSelector wallets={wallets} />);
    const menu = await open(user);

    expect(within(menu).getByRole('menuitemradio', { name: 'Educação' })).toBeChecked();
    expect(
      within(menu).getByRole('menuitemradio', { name: 'Todas as carteiras' }),
    ).not.toBeChecked();
  });

  it('checks "all wallets" when the URL names a wallet that is not in the list', async () => {
    const user = userEvent.setup();
    nav.search = `${PARAM.wallet}=gone`;
    render(<ScopeSelector wallets={wallets} />);
    const menu = await open(user);

    expect(within(menu).getByRole('menuitemradio', { name: 'Todas as carteiras' })).toBeChecked();
  });

  it('writes wallet=<id> when a wallet is chosen', async () => {
    const user = userEvent.setup();
    render(<ScopeSelector wallets={wallets} />);
    const menu = await open(user);

    await user.click(within(menu).getByRole('menuitemradio', { name: 'Aposentadoria' }));

    expect(nav.push).toHaveBeenCalledWith(`/reports?${PARAM.wallet}=w-aposentadoria`);
  });

  it('removes the parameter when "all wallets" is chosen', async () => {
    const user = userEvent.setup();
    nav.search = `${PARAM.wallet}=w-educacao`;
    render(<ScopeSelector wallets={wallets} />);
    const menu = await open(user);

    await user.click(within(menu).getByRole('menuitemradio', { name: 'Todas as carteiras' }));

    expect(nav.push).toHaveBeenCalledWith('/reports');
  });

  it('preserves every other parameter, on the same pathname', async () => {
    const user = userEvent.setup();
    nav.pathname = '/reports/patrimonio';
    nav.search = 'period=12m&grouping=sector&page=3';
    render(<ScopeSelector wallets={wallets} />);
    const menu = await open(user);

    await user.click(within(menu).getByRole('menuitemradio', { name: 'Educação' }));

    const target = nav.push.mock.lastCall?.[0] as string;
    const [path, query] = target.split('?');
    expect(path).toBe('/reports/patrimonio');
    const params = new URLSearchParams(query);
    expect(params.get(PARAM.wallet)).toBe('w-educacao');
    expect(params.get('period')).toBe('12m');
    expect(params.get('grouping')).toBe('sector');
    expect(params.get('page')).toBe('3');
  });

  it('keeps the other parameters when removing the scope too', async () => {
    const user = userEvent.setup();
    nav.search = `period=12m&${PARAM.wallet}=w-educacao`;
    render(<ScopeSelector wallets={wallets} />);
    const menu = await open(user);

    await user.click(within(menu).getByRole('menuitemradio', { name: 'Todas as carteiras' }));

    expect(nav.push).toHaveBeenCalledWith('/reports?period=12m');
  });

  it('offers only "all wallets" when there are no wallets', async () => {
    const user = userEvent.setup();
    render(<ScopeSelector wallets={[]} />);
    const menu = await open(user);
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(1);
  });

  it('carries a focus-visible ring on its trigger', () => {
    render(<ScopeSelector wallets={wallets} />);
    expect(screen.getByRole('button', { name: /Escopo/ }).className).toContain(
      'focus-visible:ring-ring',
    );
  });

  it('is operable from the keyboard alone', async () => {
    const user = userEvent.setup();
    render(<ScopeSelector wallets={wallets} />);

    await user.tab();
    expect(screen.getByRole('button', { name: /Escopo/ })).toHaveFocus();
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');
    await user.keyboard('{ArrowDown}{Enter}');

    expect(nav.push).toHaveBeenCalledWith(`/reports?${PARAM.wallet}=w-aposentadoria`);
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Escopo/ })).toHaveFocus();
  });

  it('has no axe violations closed', async () => {
    const { container } = render(<ScopeSelector wallets={wallets} />);
    expect(await audit(container)).toHaveNoViolations();
  });

  it('has no axe violations open', async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<ScopeSelector wallets={wallets} />);
    await open(user);
    expect(await audit(baseElement)).toHaveNoViolations();
  });
});
