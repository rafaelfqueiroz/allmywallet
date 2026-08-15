import { describe, expect, it } from 'vitest';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { audit, render, screen, userEvent, waitFor } from '@/components/test-utils';

function WalletSelect() {
  return (
    <>
      <Label htmlFor="carteira">Carteira</Label>
      <Select>
        <SelectTrigger id="carteira">
          <SelectValue placeholder="Escolha" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Objetivos</SelectLabel>
            <SelectItem value="aposentadoria">Aposentadoria</SelectItem>
            <SelectSeparator />
            <SelectItem value="reserva">Reserva</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </>
  );
}

describe('Select', () => {
  it('is reachable by its label and exposed as a combobox', () => {
    render(<WalletSelect />);
    expect(screen.getByRole('combobox', { name: 'Carteira' })).toBeInTheDocument();
  });

  it('carries a focus-visible ring', () => {
    render(<WalletSelect />);
    expect(screen.getByRole('combobox').className).toContain('focus-visible:ring-ring');
  });

  it('opens and commits a choice from the keyboard alone', async () => {
    const user = userEvent.setup();
    render(<WalletSelect />);

    await user.tab();
    expect(screen.getByRole('combobox')).toHaveFocus();

    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());

    await user.keyboard('{ArrowDown}{Enter}');

    await waitFor(() =>
      expect(screen.getByRole('combobox')).toHaveTextContent(/Aposentadoria|Reserva/),
    );
  });

  it('has no axe violations closed', async () => {
    const { container } = render(<WalletSelect />);
    expect(await audit(container)).toHaveNoViolations();
  });

  it('has no axe violations open', async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<WalletSelect />);

    await user.click(screen.getByRole('combobox'));
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());

    expect(await audit(baseElement)).toHaveNoViolations();
  });
});
