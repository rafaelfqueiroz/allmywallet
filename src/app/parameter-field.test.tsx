import { describe, expect, it, vi } from 'vitest';
import type { SaveParametersState } from '@/app/parameter-actions';
import { ParameterFields, type ParameterEntry } from '@/app/parameter-field';
import { render, screen, userEvent, waitFor } from '@/components/test-utils';

/**
 * SPEC-022 BR-022-37 / #248 review — a parameter form posts, beside each
 * value, the value its field was loaded with, and `saveUserParameters` writes
 * only a key whose two differ. The reference must stay the one the control on
 * screen was mounted with: the eye toggle revalidates the page with a new
 * `ui.hide_values` while the checkbox already rendered stays as it was.
 */
const entries = (hidden: boolean): ParameterEntry[] => [
  {
    key: 'ui.hide_values',
    label: 'Ocultar valores',
    hint: 'Esconde os valores.',
    invalidMessage: 'Valor não aceito.',
    control: { kind: 'boolean', value: hidden },
  },
  {
    key: 'ui.theme',
    label: 'Tema',
    hint: 'Claro, escuro ou o do sistema.',
    invalidMessage: 'Valor não aceito.',
    control: {
      kind: 'enum',
      value: 'system',
      options: [
        { value: 'system', label: 'Sistema' },
        { value: 'dark', label: 'Escuro' },
      ],
    },
  },
];

describe('ParameterFields — the loaded reference (#248 review)', () => {
  it('keeps the reference the field was mounted with across a revalidation', async () => {
    const posted: FormData[] = [];
    const action = vi.fn(async (_: SaveParametersState, data: FormData) => {
      posted.push(data);
      return { status: 'saved' } as const;
    });
    const { rerender } = render(
      <ParameterFields title="Seus ajustes" parameters={entries(false)} action={action} />,
    );

    // The eye toggle elsewhere hid the values; the page revalidates.
    rerender(<ParameterFields title="Seus ajustes" parameters={entries(true)} action={action} />);

    await userEvent.selectOptions(screen.getByLabelText('Tema'), 'dark');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(posted).toHaveLength(1));

    // The checkbox on screen was never touched and still says "visible"; its
    // reference says the same, so the key is not the user's change.
    expect(posted[0]!.get('ui.hide_values')).toBeNull();
    expect(posted[0]!.get('loaded:ui.hide_values')).toBe('false');
    expect(posted[0]!.get('ui.theme')).toBe('dark');
    expect(posted[0]!.get('loaded:ui.theme')).toBe('"system"');
  });

  it('takes the current values as the reference again once Cancelar re-mounts the fields', async () => {
    const posted: FormData[] = [];
    const action = vi.fn(async (_: SaveParametersState, data: FormData) => {
      posted.push(data);
      return { status: 'saved' } as const;
    });
    const { rerender } = render(
      <ParameterFields title="Seus ajustes" parameters={entries(false)} action={action} />,
    );
    rerender(<ParameterFields title="Seus ajustes" parameters={entries(true)} action={action} />);

    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.getByLabelText('Ocultar valores')).toBeChecked());
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.get('loaded:ui.hide_values')).toBe('true');
  });

  it('keeps what was typed through a refusal, selects included', async () => {
    const action = vi.fn(async (): Promise<SaveParametersState> => ({
      status: 'error',
      invalid: ['ui.theme'],
    }));
    render(<ParameterFields title="Seus ajustes" parameters={entries(false)} action={action} />);

    await userEvent.selectOptions(screen.getByLabelText('Tema'), 'dark');
    await userEvent.click(screen.getByLabelText('Ocultar valores'));
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Tema')).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(screen.getByLabelText('Tema')).toHaveValue('dark');
    expect(screen.getByLabelText('Ocultar valores')).toBeChecked();

    // Cancelar is what goes back to the loaded values.
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.getByLabelText('Tema')).toHaveValue('system'));
    expect(screen.getByLabelText('Ocultar valores')).not.toBeChecked();
  });
});
