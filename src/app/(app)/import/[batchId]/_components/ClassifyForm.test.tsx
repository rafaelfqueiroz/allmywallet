import { describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { TRANSACTION_TYPES } from '@/core/ledger/transaction';
import { IngestionUseCaseErrorCode } from '@/core/ingestion/errors';
import { failure, IDLE, type ActionState } from '@/lib/action-state';
import { audit, render, screen } from '@/components/test-utils';
import { ClassifyForm, type ClassifyFormLabels } from './ClassifyForm';

/**
 * SPEC-005 BR-005-20 / SPEC-007 BR-007-04a / BR-006-15 (#113).
 *
 * `classifyRowAction` itself is not called here — it needs a tenant database
 * (`withIngestionAndWalletDeps`), and this codebase does not mock ports
 * (TS-02). What is proven here is the form's own contract: every
 * `TransactionType` (the two #113 added included) is offered, the ratio
 * field exists and carries the "split/grupamento only" hint, and a refusal
 * the action returns is shown rather than swallowed — the last one exercised
 * with a fake `action`, the same technique `action-form.test.tsx` uses for
 * `ActionForm` itself.
 */
const labels: ClassifyFormLabels = {
  type: 'Classificar como',
  ratio: 'Proporção',
  ratioHint: 'Só para desdobramento e grupamento.',
  submit: 'Classificar',
  typeName: (type) => type,
};

describe('ClassifyForm', () => {
  it('offers every SPEC-006 transaction type, including leilao_fracoes and fracao_bonificacao', () => {
    render(<ClassifyForm rowId="row-1" action={async () => IDLE} labels={labels} />);

    const select = screen.getByLabelText('Classificar como') as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).toEqual([...TRANSACTION_TYPES]);
    expect(values).toContain('leilao_fracoes');
    expect(values).toContain('fracao_bonificacao');
  });

  it('always renders the ratio field, with its "split/grupamento only" hint', () => {
    render(<ClassifyForm rowId="row-1" action={async () => IDLE} labels={labels} />);

    expect(screen.getByLabelText('Proporção')).toBeInTheDocument();
    expect(screen.getByText('Só para desdobramento e grupamento.')).toBeInTheDocument();
  });

  it('pre-fills only the published multiplier supplied by the read-time resolver', () => {
    render(
      <ClassifyForm rowId="row-1" action={async () => IDLE} labels={labels} defaultRatio="0.1" />,
    );

    expect(screen.getByLabelText('Proporção')).toHaveValue('0.1');
  });

  it('submits the row id, the chosen type and the typed ratio', async () => {
    const submitted: FormData[] = [];
    const action = async (_state: ActionState, formData: FormData): Promise<ActionState> => {
      submitted.push(formData);
      return IDLE;
    };
    render(<ClassifyForm rowId="row-42" action={action} labels={labels} />);

    await userEvent.selectOptions(screen.getByLabelText('Classificar como'), 'split');
    await userEvent.type(screen.getByLabelText('Proporção'), '0,1');
    await userEvent.click(screen.getByRole('button', { name: 'Classificar' }));

    expect(submitted).toHaveLength(1);
    const data = submitted[0] as FormData;
    expect(data.get('rowId')).toBe('row-42');
    expect(data.get('type')).toBe('split');
    expect(data.get('ratio')).toBe('0,1');
  });

  it('shows a refusal the action returns, rather than swallowing it (BR-006-15)', async () => {
    const refuses = async (): Promise<ActionState> =>
      failure({ code: IngestionUseCaseErrorCode.ROW_PRICE_NOT_STATED, context: {} });
    render(<ClassifyForm rowId="row-1" action={refuses} labels={labels} />);

    await userEvent.click(screen.getByRole('button', { name: 'Classificar' }));

    // The catalogue's own pt-BR message (AR-38) — not the raw code, and not a
    // string this component invented.
    expect(await screen.findByText(/não informou o preço/)).toBeInTheDocument();
  });

  it('is accessible, including with a refusal on screen', async () => {
    const refuses = async (): Promise<ActionState> =>
      failure({ code: IngestionUseCaseErrorCode.ROW_PRICE_NOT_STATED, context: {} });
    const { container } = render(<ClassifyForm rowId="row-1" action={refuses} labels={labels} />);

    await userEvent.click(screen.getByRole('button', { name: 'Classificar' }));
    await screen.findByText(/não informou o preço/);

    expect(await audit(container)).toHaveNoViolations();
  });
});
