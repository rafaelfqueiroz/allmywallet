import { describe, expect, it, vi } from 'vitest';
import { WalletErrorCode } from '@/core/wallets/errors';
import { failure, IDLE, SAVED, type ActionState } from '@/lib/action-state';
import { WalletForm } from '@/app/(app)/settings/wallets/_components/WalletForm';
import { audit, fireEvent, render, screen, userEvent, waitFor } from '@/components/test-utils';

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

  it('starts a new wallet on "Sem cor", with no hex shown, in a control with the boundary token', () => {
    render(<CreateForm />);
    expect(screen.getByRole('checkbox', { name: 'Sem cor' })).toBeChecked();
    expect(screen.queryByText('#000000')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Cor').className).toContain('border-input');
  });

  it('unchecks "Sem cor" when a colour is picked, and shows it as text', () => {
    render(<CreateForm />);
    fireEvent.change(screen.getByLabelText('Cor'), { target: { value: '#ff0000' } });
    expect(screen.getByRole('checkbox', { name: 'Sem cor' })).not.toBeChecked();
    expect(screen.getByText('#FF0000')).toBeInTheDocument();
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

/** What the form posts, as the action would receive it. */
async function submitted(ui: React.ReactElement, change?: () => void) {
  const seen: FormData[] = [];
  const records = async (_: ActionState, formData: FormData) => {
    seen.push(formData);
    return IDLE;
  };
  render(ui.type === WalletForm ? <WalletForm {...ui.props} action={records} /> : ui);
  change?.();
  await userEvent.click(screen.getByRole('button', { name: /Criar carteira|Salvar alterações/ }));
  await waitFor(() => expect(seen).toHaveLength(1));
  return seen[0]!;
}

describe('WalletForm — Sem cor submit mapping', () => {
  const create = <WalletForm action={vi.fn()} idPrefix="new-wallet" submitLabel="Criar carteira" />;

  it('posts noColor=on for a new wallet left on its default', async () => {
    const data = await submitted(create, () => {
      fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Reserva' } });
    });
    expect(data.get('noColor')).toBe('on');
  });

  it('posts the colour and no noColor once a colour is picked', async () => {
    const data = await submitted(create, () => {
      fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Reserva' } });
      fireEvent.change(screen.getByLabelText('Cor'), { target: { value: '#ff0000' } });
    });
    expect(data.get('noColor')).toBeNull();
    expect(data.get('color')).toBe('#ff0000');
  });

  it('starts an edit of a NULL colour checked, and keeps it NULL unless changed', async () => {
    const edit = (color: string | null) => (
      <WalletForm
        action={vi.fn()}
        idPrefix="wallet"
        submitLabel="Salvar alterações"
        walletId="w1"
        values={{ name: 'Reserva', description: '', goal: '', color }}
      />
    );
    const data = await submitted(edit(null));
    expect(screen.getByRole('checkbox', { name: 'Sem cor' })).toBeChecked();
    expect(data.get('noColor')).toBe('on');
  });

  it('starts an edit of a stored colour unchecked, and posts that colour', async () => {
    const data = await submitted(
      <WalletForm
        action={vi.fn()}
        idPrefix="wallet"
        submitLabel="Salvar alterações"
        walletId="w1"
        values={{ name: 'Reserva', description: '', goal: '', color: '#336699' }}
      />,
    );
    expect(screen.getByRole('checkbox', { name: 'Sem cor' })).not.toBeChecked();
    expect(data.get('noColor')).toBeNull();
    expect(data.get('color')).toBe('#336699');
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
