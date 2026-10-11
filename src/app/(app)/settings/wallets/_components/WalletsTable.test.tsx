import { describe, expect, it, vi } from 'vitest';
import {
  WalletsTable,
  type WalletRow,
} from '@/app/(app)/settings/wallets/_components/WalletsTable';
import { audit, render, screen, within } from '@/components/test-utils';

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/wallets',
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

/**
 * SPEC-022 BR-022-05 — Configurações › Carteiras' list is setup data: name,
 * purpose, a count of assets and a date. Never a value, cost or share.
 */
const rows: WalletRow[] = [
  {
    id: 'w-edu',
    name: 'Educação',
    description: 'Faculdade em 2034',
    goal: 'Pagar a faculdade',
    color: '#336699',
    assetCount: 4,
    updatedAtText: '15/08/2026',
    updatedAtMs: Date.UTC(2026, 7, 15),
  },
  {
    id: 'w-apo',
    name: 'Aposentadoria',
    description: null,
    goal: null,
    color: null,
    assetCount: 14,
    updatedAtText: '02/10/2026',
    updatedAtMs: Date.UTC(2026, 9, 2),
  },
];

describe('WalletsTable', () => {
  it('lists each wallet with its name as a link to its own page, count and date', () => {
    render(<WalletsTable rows={rows} />);
    const table = screen.getByRole('table', { name: /Minhas carteiras/ });

    const link = within(table).getByRole('link', { name: 'Educação' });
    expect(link).toHaveAttribute('href', '/settings/wallets/w-edu');
    expect(within(table).getByText('Faculdade em 2034')).toBeInTheDocument();
    expect(within(table).getByText('Pagar a faculdade')).toBeInTheDocument();
    expect(within(table).getByText('15/08/2026')).toBeInTheDocument();
    expect(within(table).getByText('14')).toBeInTheDocument();
  });

  it('opens sorted by name, with the four columns the prototype shows', () => {
    render(<WalletsTable rows={rows} />);
    const table = screen.getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Carteira', 'Objetivo', 'Ativos', 'Atualizada em']);
    const links = within(table).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Aposentadoria', 'Educação']);
  });

  it('shows no portfolio figure — no currency amount, percentage or cost', () => {
    const { container } = render(<WalletsTable rows={rows} />);
    expect(container.textContent).not.toMatch(/R\$/);
    expect(container.textContent).not.toMatch(/%/);
  });

  it('offers a search by wallet', () => {
    render(<WalletsTable rows={rows} />);
    expect(screen.getByPlaceholderText('Buscar carteira')).toBeInTheDocument();
  });

  it('explains the empty state and says how to start', () => {
    render(<WalletsTable rows={[]} />);
    expect(screen.getByText('Você ainda não criou nenhuma carteira.')).toBeInTheDocument();
    expect(screen.getByText(/Crie a primeira em Nova carteira/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('has no axe violations, with rows and empty', async () => {
    const full = render(<WalletsTable rows={rows} />);
    expect(await audit(full.container)).toHaveNoViolations();
    full.unmount();
    const empty = render(<WalletsTable rows={[]} />);
    expect(await audit(empty.container)).toHaveNoViolations();
  });
});
