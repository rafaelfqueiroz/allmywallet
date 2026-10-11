import { describe, expect, it } from 'vitest';
import { USER_EDITABLE_TRANSACTION_TYPES } from '@/core/ledger/transaction';
import { LedgerErrorCode } from '@/core/ledger/errors';
import { IDLE, failure, type ActionState } from '@/lib/action-state';
import { domainError } from '@/core/shared/domain-error';
import { audit, render, screen, userEvent } from '@/components/test-utils';
import { TransactionForm, type TransactionFormProps } from './TransactionForm';

const props: TransactionFormProps = {
  action: async () => IDLE,
  mode: 'create',
  values: {
    assetId: '',
    institutionId: '',
    type: 'buy',
    tradeDate: '',
    quantity: '',
    unitPrice: '',
    fees: '',
    ratio: '',
  },
  assetOptions: [],
  institutionOptions: [],
  assetClasses: [],
  walletOptions: [],
};

describe('TransactionForm', () => {
  it('offers ordinary transaction types but no standalone conversion leg', () => {
    render(<TransactionForm {...props} />);

    const select = screen.getByLabelText('Tipo') as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);

    expect(values).toEqual([...USER_EDITABLE_TRANSACTION_TYPES]);
    expect(values).not.toContain('conversion_out');
    expect(values).not.toContain('conversion_in');
  });

  /** SPEC-022 BR-022-20 — fields in a row share one height. */
  it('gives every control one height and every label row the same box', () => {
    const { container } = render(
      <TransactionForm {...props} walletOptions={[{ walletId: 'w', name: 'Aposentadoria' }]} />,
    );
    const controls = container.querySelectorAll<HTMLElement>(
      '[data-slot="field"] input, [data-slot="field"] select',
    );
    expect(controls.length).toBeGreaterThanOrEqual(13);
    for (const control of controls) expect(control.className).toMatch(/(^|\s)h-8(\s|$)/);
    // A hint is an icon in the label row, never a paragraph that grows the field.
    for (const row of container.querySelectorAll('[data-slot="field-label-row"]')) {
      expect(row.className).toContain('min-h-5');
    }
    expect(container.querySelectorAll('[data-slot="field"] p')).toHaveLength(0);
    expect(screen.getByLabelText('Preço unitário')).toHaveAccessibleDescription(
      'Use vírgula para os centavos.',
    );
  });

  /** BR-022-21 — a refusal about one field renders under that field. */
  it('puts a field refusal under its field and keeps what was typed', async () => {
    const user = userEvent.setup();
    const refuse = async (): Promise<ActionState> =>
      failure(domainError(LedgerErrorCode.NEGATIVE_FEES, {}));
    const { container } = render(<TransactionForm {...props} action={refuse} />);

    // Every `required` field filled: jsdom, like a browser, will not submit otherwise.
    await user.type(screen.getByLabelText('Data da operação'), '2026-04-01');
    await user.type(screen.getByLabelText('Quantidade'), '10');
    await user.type(screen.getByLabelText('Preço unitário'), '32,15');
    await user.type(screen.getByLabelText('Taxas'), '-1');
    await user.click(screen.getByRole('button', { name: 'Registrar transação' }));

    const fees = await screen.findByLabelText('Taxas');
    expect(fees).toHaveAttribute('aria-invalid', 'true');
    expect(fees).toHaveAccessibleDescription('As taxas não podem ser negativas.');
    expect(container.querySelector('[data-slot="error-state"]')).toBeNull();
    expect(screen.getByLabelText('Quantidade')).toHaveValue('10');
    expect(screen.getByLabelText('Preço unitário')).toHaveValue('32,15');
  });

  it('keeps a refusal about the whole transaction in the banner', async () => {
    const user = userEvent.setup();
    const refuse = async (): Promise<ActionState> =>
      failure(domainError('INSUFFICIENT_QUANTITY', { held: '10', requested: '999', date: '' }));
    const { container } = render(<TransactionForm {...props} action={refuse} />);

    await user.type(screen.getByLabelText('Data da operação'), '2026-04-01');
    await user.type(screen.getByLabelText('Quantidade'), '999');
    await user.type(screen.getByLabelText('Preço unitário'), '1');
    await user.click(screen.getByRole('button', { name: 'Registrar transação' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(container.querySelector('[aria-invalid="true"]')).toBeNull();
  });

  it('is accessible at the generic single-transaction boundary', async () => {
    const { container } = render(<TransactionForm {...props} />);

    expect(await audit(container)).toHaveNoViolations();
  });
});
