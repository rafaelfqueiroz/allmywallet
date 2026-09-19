import { describe, expect, it } from 'vitest';
import { USER_EDITABLE_TRANSACTION_TYPES } from '@/core/ledger/transaction';
import { IDLE } from '@/lib/action-state';
import { audit, render, screen } from '@/components/test-utils';
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

  it('is accessible at the generic single-transaction boundary', async () => {
    const { container } = render(<TransactionForm {...props} />);

    expect(await audit(container)).toHaveNoViolations();
  });
});
