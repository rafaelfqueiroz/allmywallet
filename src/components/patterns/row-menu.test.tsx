import { describe, expect, it, vi } from 'vitest';
import { RowMenu, RowMenuSubmit } from '@/components/patterns/row-menu';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { audit, render, screen, userEvent } from '@/components/test-utils';

/**
 * SPEC-022 BR-022-41 — a row's actions behind "⋯". The item submits a form
 * outside the menu by id, because the menu unmounts before a native submit
 * from a button inside it would fire.
 */
function renderMenu(onSubmit: (event: SubmitEvent) => void) {
  const view = render(
    <>
      <RowMenu label="Ações da regra de PETR4">
        <RowMenuSubmit form="mute-PETR4">Silenciar avisos</RowMenuSubmit>
        <DropdownMenuItem asChild>
          <a href="?rule=PETR4">Editar regra</a>
        </DropdownMenuItem>
        <RowMenuSubmit form="delete-PETR4" destructive>
          Excluir regra
        </RowMenuSubmit>
      </RowMenu>
      <form
        id="mute-PETR4"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(event.nativeEvent as SubmitEvent);
        }}
      />
    </>,
  );
  return view;
}

describe('RowMenu', () => {
  it('names the row on its trigger and lists the actions as menu items', async () => {
    const user = userEvent.setup();
    renderMenu(vi.fn());

    await user.click(screen.getByRole('button', { name: 'Ações da regra de PETR4' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Silenciar avisos',
      'Editar regra',
      'Excluir regra',
    ]);
    expect(screen.getByRole('menuitem', { name: 'Excluir regra' })).toHaveAttribute(
      'data-variant',
      'destructive',
    );
  });

  it('submits the named form when an item is chosen, and closes', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderMenu(onSubmit);

    await user.click(screen.getByRole('button', { name: 'Ações da regra de PETR4' }));
    await user.click(screen.getByRole('menuitem', { name: 'Silenciar avisos' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('submits nothing when the form does not exist', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderMenu(onSubmit);

    await user.click(screen.getByRole('button', { name: 'Ações da regra de PETR4' }));
    await user.click(screen.getByRole('menuitem', { name: 'Excluir regra' }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('has no axe violations, open', async () => {
    const user = userEvent.setup();
    const { baseElement } = renderMenu(vi.fn());
    await user.click(screen.getByRole('button', { name: 'Ações da regra de PETR4' }));
    expect(await audit(baseElement)).toHaveNoViolations();
  });
});
