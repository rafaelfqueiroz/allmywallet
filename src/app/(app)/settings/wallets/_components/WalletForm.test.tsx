import { describe, expect, it, vi } from 'vitest';
import { WalletErrorCode } from '@/core/wallets/errors';
import { failure, IDLE, SAVED, type ActionState } from '@/lib/action-state';
import { WalletForm } from '@/app/(app)/settings/wallets/_components/WalletForm';
import { audit, render, screen, userEvent, waitFor } from '@/components/test-utils';

/**
 * SPEC-022 BR-022-20/21 — instructions behind the icon, one height per field,
 * and a refusal under the field it is about. SPEC-010 BR-010-01: a blank name
 * is refused (`INVALID_NAME`), and the refusal must reach the Nome field.
 */
const refusesName = async (): Promise<ActionState> =>
  failure({
    code: WalletErrorCode.INVALID_NAME,
    context: {},
  });

function CreateForm({ action = vi.fn(async () => IDLE) }: { action?: () => Promise<ActionState> }) {
  return (
    <WalletForm
      action={action}
      idPrefix="new-wallet"
      submitLabel="Criar carteira"
      cancelHref="/settings/wallets"
    />
  );
}

describe('WalletForm — fields (BR-022-20)', () => {
  it('gives Nome, Descrição, Objetivo and Cor one height, so a row of them stays aligned', () => {
    render(<CreateForm />);
    const controls = [
      screen.getByLabelText('Nome'),
      screen.getByLabelText('Descrição'),
      screen.getByLabelText('Objetivo'),
      screen.getByLabelText('Cor'),
    ];
    for (const control of controls) expect(control.className).toMatch(/(^|\s)h-8(\s|$)/);
  });

  it('keeps the Objetivo instructions in its description, behind the info icon', () => {
    render(<CreateForm />);
    const goal = screen.getByLabelText('Objetivo');
    expect(goal).toHaveAccessibleDescription(/O propósito desta carteira/);
    // The icon is the only on-screen trace of the instructions.
    expect(screen.getByRole('button', { name: 'Instruções sobre Objetivo' })).toBeInTheDocument();
    expect(document.querySelectorAll('[data-slot="field"] p')).toHaveLength(0);
  });

  it('shows the colour as text as well as a swatch, and in a control that is not a bare input', () => {
    render(<CreateForm />);
    expect(screen.getByText('#000000')).toBeInTheDocument();
    expect(screen.getByLabelText('Cor').className).toContain('border-input');
  });

  it('offers Cancelar back to the list and Criar carteira', () => {
    render(<CreateForm />);
    expect(screen.getByRole('link', { name: 'Cancelar' })).toHaveAttribute(
      'href',
      '/settings/wallets',
    );
    expect(screen.getByRole('button', { name: 'Criar carteira' })).toBeInTheDocument();
  });

  it('marks Nome as required', () => {
    render(<CreateForm />);
    expect(screen.getByLabelText('Nome')).toBeRequired();
  });
});

describe('WalletForm — a refusal lands under its field (BR-022-21)', () => {
  it('renders INVALID_NAME under Nome, marks it invalid and keeps what else was typed', async () => {
    render(<CreateForm action={refusesName} />);

    // Whitespace passes `required` and is exactly what the domain refuses.
    await userEvent.type(screen.getByLabelText('Nome'), '   ');
    await userEvent.type(screen.getByLabelText('Descrição'), 'Longo prazo');
    await userEvent.click(screen.getByRole('button', { name: 'Criar carteira' }));

    const name = await screen.findByLabelText('Nome');
    await waitFor(() => expect(name).toHaveAttribute('aria-invalid', 'true'));
    expect(name).toHaveAccessibleDescription('A carteira precisa de um nome.');
    // Under the field, not in a banner above the form.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(document.getElementById('new-wallet-name-error')).toHaveTextContent(
      'A carteira precisa de um nome.',
    );
    // The refusal does not cost the user the rest of the form.
    expect(screen.getByLabelText('Descrição')).toHaveValue('Longo prazo');
  });

  it('keeps an error that is not about a field in the banner', async () => {
    const refusesElsewhere = async (): Promise<ActionState> =>
      failure({ code: WalletErrorCode.WALLET_NOT_FOUND, context: {} });
    render(<CreateForm action={refusesElsewhere} />);

    await userEvent.type(screen.getByLabelText('Nome'), 'Aposentadoria');
    await userEvent.click(screen.getByRole('button', { name: 'Criar carteira' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Esta carteira não existe mais');
    expect(screen.getByLabelText('Nome')).not.toHaveAttribute('aria-invalid');
  });

  it('says so when an edit is saved', async () => {
    const saves = async (): Promise<ActionState> => SAVED;
    render(
      <WalletForm
        action={saves}
        idPrefix="wallet"
        submitLabel="Salvar alterações"
        walletId="w1"
        values={{ name: 'Educação', description: '', goal: '', color: '#336699' }}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Alterações salvas.');
    expect(screen.getByLabelText('Nome')).toHaveValue('Educação');
    expect(screen.getByText('#336699')).toBeInTheDocument();
  });

  it('has no axe violations, with and without a refusal', async () => {
    const { container } = render(<CreateForm action={refusesName} />);
    expect(await audit(container)).toHaveNoViolations();

    await userEvent.type(screen.getByLabelText('Nome'), '  ');
    await userEvent.click(screen.getByRole('button', { name: 'Criar carteira' }));
    await screen.findByText('A carteira precisa de um nome.');
    expect(await audit(container)).toHaveNoViolations();
  });
});
