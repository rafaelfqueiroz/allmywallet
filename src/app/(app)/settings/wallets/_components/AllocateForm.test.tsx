import { describe, expect, it } from 'vitest';
import { WalletErrorCode } from '@/core/wallets/errors';
import { failure, IDLE, type ActionState } from '@/lib/action-state';
import { AllocateForm } from '@/app/(app)/settings/wallets/_components/AllocateForm';
import { audit, render, screen, userEvent, waitFor } from '@/components/test-utils';

/**
 * SPEC-010 BR-010-03/05/09/13 and SPEC-022 BR-022-21 — assigning a held asset
 * to a wallet: an over-allocation is refused (AC-010-04) and the refusal, which
 * names the ceiling, is said under Quantidade.
 */
const choice = {
  name: 'assetId',
  label: 'Ativo',
  placeholder: 'Escolha um ativo',
  options: [{ value: 'a1', label: 'PETR4 — Petrobras PN — 100 não atribuída(s)' }],
} as const;

function Form({ action }: { action: (s: ActionState, f: FormData) => Promise<ActionState> }) {
  return (
    <AllocateForm
      title="Atribuir ativo"
      action={action}
      idPrefix="assign"
      fixed={{ name: 'walletId', value: 'w1' }}
      choice={choice}
      quantityHint="Opcional. Em branco, atribui toda a quantidade."
      submitLabel="Atribuir"
    />
  );
}

describe('AllocateForm — after a success', () => {
  const walletChoice = {
    name: 'walletId',
    label: 'Atribuir a',
    placeholder: 'Escolha uma carteira',
    options: [{ value: 'w1', label: 'Aposentadoria' }],
  } as const;

  function Queue({ defaultQuantity }: { defaultQuantity: string }) {
    return (
      <AllocateForm
        title="Atribuir ativo"
        action={async () => IDLE}
        idPrefix="allocate-a1"
        fixed={{ name: 'assetId', value: 'a1' }}
        choice={walletChoice}
        defaultQuantity={defaultQuantity}
        submitLabel="Atribuir"
      />
    );
  }

  it('offers the new remainder, not the 60 that was just assigned', async () => {
    const { rerender } = render(<Queue defaultQuantity="100" />);

    await userEvent.selectOptions(screen.getByLabelText('Atribuir a'), 'w1');
    const quantity = screen.getByLabelText('Quantidade');
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '60');
    await userEvent.click(screen.getByRole('button', { name: 'Atribuir' }));

    // The server re-renders the queue with what is left unassigned.
    rerender(<Queue defaultQuantity="40" />);
    await waitFor(() => expect(screen.getByLabelText('Quantidade')).toHaveValue('40'));
    expect(screen.getByLabelText('Atribuir a')).toHaveValue('');
  });

  it('clears the asset and the quantity on the wallet page, where there is no default', async () => {
    render(<Form action={async () => IDLE} />);
    await userEvent.selectOptions(screen.getByLabelText('Ativo'), 'a1');
    await userEvent.type(screen.getByLabelText('Quantidade'), '60');
    await userEvent.click(screen.getByRole('button', { name: 'Atribuir' }));

    await waitFor(() => expect(screen.getByLabelText('Quantidade')).toHaveValue(''));
    expect(screen.getByLabelText('Ativo')).toHaveValue('');
  });
});

describe('AllocateForm', () => {
  it('renders the refusal of an over-allocation under Quantidade, with the held ceiling', async () => {
    const exceeds = async () =>
      failure({
        code: WalletErrorCode.ALLOCATION_EXCEEDS_HOLDINGS,
        context: { held: '100', requested: '150' },
      });
    render(<Form action={exceeds} />);

    await userEvent.selectOptions(screen.getByLabelText('Ativo'), 'a1');
    await userEvent.type(screen.getByLabelText('Quantidade'), '150');
    await userEvent.click(screen.getByRole('button', { name: 'Atribuir' }));

    const quantity = screen.getByLabelText('Quantidade');
    await waitFor(() => expect(quantity).toHaveAttribute('aria-invalid', 'true'));
    expect(quantity).toHaveAccessibleDescription(/você tem 100/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // Typed values survive the refusal, so correcting a number is not starting over.
    expect(quantity).toHaveValue('150');
    expect(screen.getByLabelText('Ativo')).toHaveValue('a1');
  });

  it('renders an invalid quantity under Quantidade too', async () => {
    const invalid = async () =>
      failure({
        code: WalletErrorCode.INVALID_ALLOCATION_QUANTITY,
        context: { quantity: 'abc' },
      });
    render(<Form action={invalid} />);
    await userEvent.selectOptions(screen.getByLabelText('Ativo'), 'a1');
    await userEvent.type(screen.getByLabelText('Quantidade'), 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'Atribuir' }));
    expect(await screen.findByText(/A quantidade abc não pode ser atribuída/)).toBeInTheDocument();
  });

  it('posts the fixed wallet, and leaves Quantidade empty to mean the whole remainder', async () => {
    const seen: FormData[] = [];
    const records = async (_: ActionState, formData: FormData) => {
      seen.push(formData);
      return IDLE;
    };
    render(<Form action={records} />);
    await userEvent.selectOptions(screen.getByLabelText('Ativo'), 'a1');
    await userEvent.click(screen.getByRole('button', { name: 'Atribuir' }));

    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.get('walletId')).toBe('w1');
    expect(seen[0]?.get('assetId')).toBe('a1');
    expect(seen[0]?.get('quantity')).toBe('');
  });

  it('keeps the Quantidade instructions behind the info icon and in its description', () => {
    render(<Form action={async () => IDLE} />);
    expect(screen.getByLabelText('Quantidade')).toHaveAccessibleDescription(/Em branco/);
    expect(screen.getByRole('button', { name: 'Instruções sobre Quantidade' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<Form action={async () => IDLE} />);
    expect(await audit(container)).toHaveNoViolations();
  });
});
