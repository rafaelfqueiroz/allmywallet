import { describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { IngestionUseCaseErrorCode } from '@/core/ingestion/errors';
import { IGNORE_REASON_MAX_LENGTH } from '@/core/ingestion/ignore-row';
import { failure, IDLE, type ActionState } from '@/lib/action-state';
import { audit, render, screen } from '@/components/test-utils';
import { IgnoreForm, type IgnoreFormLabels } from './IgnoreForm';

/**
 * SPEC-005 BR-005-20f (#215). `ignoreRowAction` needs a tenant database, so a
 * fake `action` stands in (TS-02, as `ClassifyForm.test.tsx` does): what is
 * proven here is the form's contract — the reason is a required, bounded
 * field, it is submitted with the row, and a refusal is shown.
 */
const labels: IgnoreFormLabels = {
  reason: 'Ignorar, com motivo',
  reasonHint: 'Você pode classificá-la depois, em Ignoradas.',
  submit: 'Ignorar',
};

const refuses = async (): Promise<ActionState> =>
  failure({
    code: IngestionUseCaseErrorCode.IGNORE_REASON_INVALID,
    context: { maxLength: IGNORE_REASON_MAX_LENGTH },
  });

describe('IgnoreForm', () => {
  it('asks for a required reason, bounded as the use case bounds it', () => {
    render(<IgnoreForm rowId="row-1" action={async () => IDLE} labels={labels} />);

    const reason = screen.getByLabelText('Ignorar, com motivo');
    expect(reason).toBeRequired();
    expect(reason).toHaveAttribute('maxLength', String(IGNORE_REASON_MAX_LENGTH));
  });

  it('submits the row id and the typed reason', async () => {
    const submitted: FormData[] = [];
    const action = async (_state: ActionState, formData: FormData): Promise<ActionState> => {
      submitted.push(formData);
      return IDLE;
    };
    render(<IgnoreForm rowId="row-42" action={action} labels={labels} />);

    await userEvent.type(screen.getByLabelText('Ignorar, com motivo'), 'Não move a posição');
    await userEvent.click(screen.getByRole('button', { name: 'Ignorar' }));

    expect(submitted).toHaveLength(1);
    const data = submitted[0] as FormData;
    expect(data.get('rowId')).toBe('row-42');
    expect(data.get('reason')).toBe('Não move a posição');
  });

  it('shows a refusal the action returns, with the catalogue message', async () => {
    render(<IgnoreForm rowId="row-1" action={refuses} labels={labels} />);

    await userEvent.type(screen.getByLabelText('Ignorar, com motivo'), ' ');
    await userEvent.click(screen.getByRole('button', { name: 'Ignorar' }));

    expect(await screen.findByText(/em até 500 caracteres/)).toBeInTheDocument();
  });

  it('is accessible, including with a refusal on screen', async () => {
    const { container } = render(<IgnoreForm rowId="row-1" action={refuses} labels={labels} />);

    await userEvent.type(screen.getByLabelText('Ignorar, com motivo'), ' ');
    await userEvent.click(screen.getByRole('button', { name: 'Ignorar' }));
    await screen.findByText(/em até 500 caracteres/);

    expect(await audit(container)).toHaveNoViolations();
  });
});
