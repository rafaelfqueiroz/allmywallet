import { describe, expect, it } from 'vitest';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { audit, render, screen, userEvent, waitFor } from '@/components/test-utils';

function Example() {
  return (
    <Popover>
      <PopoverTrigger>Detalhes</PopoverTrigger>
      <PopoverContent aria-label="Detalhes">Texto de apoio</PopoverContent>
    </Popover>
  );
}

describe('Popover', () => {
  it('is closed until its trigger is pressed', async () => {
    const user = userEvent.setup();
    render(<Example />);
    expect(screen.queryByText('Texto de apoio')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Detalhes' }));
    expect(screen.getByText('Texto de apoio')).toBeInTheDocument();
  });

  // WCAG 1.4.13 — the content is dismissible without moving the pointer.
  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.click(screen.getByRole('button', { name: 'Detalhes' }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText('Texto de apoio')).not.toBeInTheDocument());
  });

  it('draws on the popover surface and the raised shadow token', async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.click(screen.getByRole('button', { name: 'Detalhes' }));
    const content = screen.getByText('Texto de apoio');
    expect(content.className).toContain('bg-popover');
    expect(content.className).toContain('shadow-(--shadow-raised)');
  });

  it('has no axe violations while open', async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<Example />);
    await user.click(screen.getByRole('button', { name: 'Detalhes' }));
    expect(await audit(baseElement)).toHaveNoViolations();
  });
});
