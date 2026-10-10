import { describe, expect, it, vi } from 'vitest';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { audit, render, screen, userEvent, waitFor, within } from '@/components/test-utils';

function AccountMenu({ onSelect = () => {} }: { onSelect?: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>Ana Ribeiro</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>Conta</DropdownMenuLabel>
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={onSelect}>Preferências</DropdownMenuItem>
          <DropdownMenuItem>Privacidade</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive">Sair</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

describe('DropdownMenu', () => {
  it('exposes its trigger as a menu button and starts closed', () => {
    render(<AccountMenu />);
    const trigger = screen.getByRole('button', { name: 'Ana Ribeiro' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('carries a focus-visible ring on the items it highlights with accent', async () => {
    const user = userEvent.setup();
    render(<AccountMenu />);
    await user.click(screen.getByRole('button', { name: 'Ana Ribeiro' }));

    const item = await screen.findByRole('menuitem', { name: 'Preferências' });
    expect(item.className).toContain('focus:bg-accent');
    expect(screen.getByRole('menu').className).toContain('bg-popover');
  });

  it.each(['{Enter}', '{ArrowDown}'])('opens from the keyboard with %s', async (key) => {
    const user = userEvent.setup();
    render(<AccountMenu />);

    await user.tab();
    expect(screen.getByRole('button', { name: 'Ana Ribeiro' })).toHaveFocus();
    await user.keyboard(key);

    expect(await screen.findByRole('menu')).toBeInTheDocument();
  });

  it('moves between items with the arrow keys and activates with Enter', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<AccountMenu onSelect={onSelect} />);

    await user.tab();
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');

    // Opened from the keyboard, the first item already has focus.
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: 'Preferências' })).toHaveFocus(),
    );
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Privacidade' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'Preferências' })).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<AccountMenu />);

    await user.tab();
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');
    await user.keyboard('{ArrowDown}');

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Ana Ribeiro' })).toHaveFocus();
  });

  it('supports radio items that report which one is checked', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Escopo</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup value="all">
            <DropdownMenuRadioItem value="all">Todas as carteiras</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="a">Aposentadoria</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByRole('button', { name: 'Escopo' }));

    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitemradio', { name: 'Todas as carteiras' })).toBeChecked();
    expect(within(menu).getByRole('menuitemradio', { name: 'Aposentadoria' })).not.toBeChecked();
  });

  it('supports checkbox items', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Colunas</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuCheckboxItem checked>Preço médio</DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByRole('button', { name: 'Colunas' }));
    expect(await screen.findByRole('menuitemcheckbox', { name: 'Preço médio' })).toBeChecked();
  });

  it('has no axe violations closed', async () => {
    const { container } = render(<AccountMenu />);
    expect(await audit(container)).toHaveNoViolations();
  });

  it('has no axe violations open', async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<AccountMenu />);
    await user.click(screen.getByRole('button', { name: 'Ana Ribeiro' }));
    await screen.findByRole('menu');
    expect(await audit(baseElement)).toHaveNoViolations();
  });
});
