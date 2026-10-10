import { describe, expect, it } from 'vitest';
import { Field } from '@/components/patterns/field';
import { Input } from '@/components/ui/input';
import { audit, render, screen, userEvent } from '@/components/test-utils';

/**
 * SPEC-022 BR-022-20/21 — instructions behind an icon, errors inline.
 * The older association tests (label, description, invalid) live in
 * `forms.test.tsx`.
 */
function structure(container: HTMLElement) {
  const field = container.querySelector('[data-slot="field"]') as HTMLElement;
  const row = field.querySelector('[data-slot="field-label-row"]') as HTMLElement;
  return { field, row };
}

describe('Field — instructions (BR-022-20)', () => {
  it('renders the hint as an info icon beside the label, not as a paragraph', () => {
    const { container } = render(
      <Field id="tol" label="Tolerância de desvio" hint="Quanto a alocação pode variar.">
        <Input name="tol" />
      </Field>,
    );
    const { row } = structure(container);
    expect(row).toContainElement(screen.getByRole('button', { name: /Instruções sobre/ }));
    expect(container.querySelector('p')).toBeNull();
  });

  it('keeps the hint in the control description even though it is not on screen', () => {
    render(
      <Field id="tol" label="Tolerância de desvio" hint="Quanto a alocação pode variar.">
        <Input name="tol" />
      </Field>,
    );
    const control = screen.getByLabelText('Tolerância de desvio');
    expect(control).toHaveAttribute('aria-describedby', 'tol-hint');
    expect(control).toHaveAccessibleDescription('Quanto a alocação pode variar.');
    expect(document.getElementById('tol-hint')).not.toBeVisible();
  });

  it('has the same structure and height classes with and without a hint', () => {
    const withHint = render(
      <Field id="a" label="Objetivo" hint="Texto">
        <Input name="a" />
      </Field>,
    );
    const a = structure(withHint.container);
    const aRowClass = a.row.className;
    const aFieldClass = a.field.className;
    const aInFlow = [...a.field.children].filter((el) => !el.hasAttribute('hidden'));
    const aTags = aInFlow.map((el) => el.tagName);
    withHint.unmount();

    const without = render(
      <Field id="b" label="Objetivo">
        <Input name="b" />
      </Field>,
    );
    const b = structure(without.container);
    expect(b.row.className).toBe(aRowClass);
    expect(b.field.className).toBe(aFieldClass);
    expect([...b.field.children].map((el) => el.tagName)).toEqual(aTags);
    // The fixed line box: an icon can never make the row taller.
    expect(aRowClass).toContain('min-h-5');
  });

  it('opens the instructions from the icon', async () => {
    const user = userEvent.setup();
    render(
      <Field id="tol" label="Tolerância de desvio" hint="Quanto a alocação pode variar.">
        <Input name="tol" />
      </Field>,
    );
    await user.tab();
    expect(screen.getByRole('button', { name: /Instruções sobre/ })).toHaveFocus();
    expect(screen.getByRole('note')).toHaveTextContent('Quanto a alocação pode variar.');
  });

  it('does not make the icon match a query for the field itself', () => {
    render(
      <Field id="tol" label="Tolerância" hint="Texto">
        <Input name="tol" />
      </Field>,
    );
    expect(screen.getByLabelText('Tolerância')).toHaveAttribute('name', 'tol');
  });
});

describe('Field — errors (BR-022-21)', () => {
  it('shows the error inline and visible without opening anything', () => {
    render(
      <Field id="nome" label="Nome" hint="Texto" error="Já existe uma carteira com esse nome.">
        <Input name="nome" />
      </Field>,
    );
    const error = screen.getByText('Já existe uma carteira com esse nome.');
    expect(error).toBeVisible();
    expect(error).toHaveAttribute('id', 'nome-error');
    expect(error.className).toContain('text-danger');
    expect(screen.getByLabelText('Nome')).toHaveAccessibleDescription(
      'Texto Já existe uma carteira com esse nome.',
    );
  });

  it('has no axe violations with a hint and an error', async () => {
    const { container } = render(
      <Field id="nome" label="Nome" hint="Texto" error="Obrigatório">
        <Input name="nome" />
      </Field>,
    );
    expect(await audit(container)).toHaveNoViolations();
  });
});
