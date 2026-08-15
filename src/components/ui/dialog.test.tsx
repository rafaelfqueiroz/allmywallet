import { describe, expect, it } from 'vitest';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { audit, render, screen, userEvent, waitFor } from '@/components/test-utils';

function ConfirmDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button>Excluir</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Excluir carteira</DialogTitle>
          <DialogDescription>Esta ação não pode ser desfeita.</DialogDescription>
        </DialogHeader>
        <DialogFooter showCloseButton>
          <DialogClose asChild>
            <Button>Confirmar</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

describe('Dialog', () => {
  it('opens from its trigger and is named by its title', async () => {
    const user = userEvent.setup();
    render(<ConfirmDialog />);

    await user.click(screen.getByRole('button', { name: 'Excluir' }));

    expect(await screen.findByRole('dialog', { name: 'Excluir carteira' })).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<ConfirmDialog />);

    await user.click(screen.getByRole('button', { name: 'Excluir' }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('moves focus into the dialog rather than leaving it on the page behind', async () => {
    const user = userEvent.setup();
    render(<ConfirmDialog />);

    await user.click(screen.getByRole('button', { name: 'Excluir' }));
    const dialog = await screen.findByRole('dialog');

    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it('labels both close affordances in pt-BR, from the catalogue', async () => {
    const user = userEvent.setup();
    render(<ConfirmDialog />);

    await user.click(screen.getByRole('button', { name: 'Excluir' }));
    await screen.findByRole('dialog');

    // The icon button in the corner and the footer button. Both arrived from
    // the shadcn registry as the literal "Close"; both now resolve common.close.
    expect(screen.getAllByRole('button', { name: 'Fechar' })).toHaveLength(2);
  });

  it('has no axe violations while open', async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<ConfirmDialog />);

    await user.click(screen.getByRole('button', { name: 'Excluir' }));
    await screen.findByRole('dialog');

    expect(await audit(baseElement)).toHaveNoViolations();
  });
});
