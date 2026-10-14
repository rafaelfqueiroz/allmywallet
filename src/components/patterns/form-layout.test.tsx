import { describe, expect, it } from 'vitest';
import { Field } from '@/components/patterns/field';
import { FormActions, FormGrid, FormPanel } from '@/components/patterns/form-layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { audit, render, screen } from '@/components/test-utils';

/**
 * SPEC-022 BR-022-37 — every create or edit form has one layout: a panel with
 * a title, fields two to a row, and a footer with the destructive action alone
 * at the left and Cancelar, then the primary action, at the right.
 */
describe('FormActions', () => {
  const footer = () =>
    render(
      <FormActions
        destructive={<Button variant="destructive">Excluir carteira</Button>}
        status={<span role="status">Alterações salvas.</span>}
        cancel={<Button variant="outline">Cancelar</Button>}
      >
        <Button type="submit">Salvar alterações</Button>
      </FormActions>,
    );

  it('puts the destructive action alone, first, in its own group', () => {
    const { container } = footer();
    const row = container.querySelector('[data-slot=form-actions]')!;
    const [left, right] = Array.from(row.children);
    expect(left).toHaveAttribute('data-slot', 'form-actions-destructive');
    expect(left).toHaveTextContent(/^Excluir carteira$/);
    expect(right).toHaveAttribute('data-slot', 'form-actions-main');
    expect(right).not.toContainElement(screen.getByRole('button', { name: 'Excluir carteira' }));
  });

  it('orders the right-hand group Cancelar, then the primary action, last', () => {
    const { container } = footer();
    const right = container.querySelector('[data-slot=form-actions-main]')!;
    const buttons = Array.from(right.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toEqual(['Cancelar', 'Salvar alterações']);
    // The group is pushed to the right edge whether or not a destructive action exists.
    expect(right).toHaveClass('ml-auto', 'justify-end');
  });

  it('reads in the order it is drawn: destructive, status, Cancelar, primary', () => {
    const { container } = footer();
    expect(container.querySelector('[data-slot=form-actions]')).toHaveTextContent(
      'Excluir carteiraAlterações salvas.CancelarSalvar alterações',
    );
  });

  it('renders no left group without a destructive action', () => {
    const { container } = render(
      <FormActions>
        <Button type="submit">Criar</Button>
      </FormActions>,
    );
    expect(container.querySelector('[data-slot=form-actions-destructive]')).toBeNull();
  });
});

describe('FormGrid', () => {
  it('is one column, and two from its container’s @xl breakpoint', () => {
    const { container } = render(
      <FormGrid>
        <Field id="name" label="Nome">
          <Input />
        </Field>
      </FormGrid>,
    );
    expect(container.querySelector('[data-slot=form-grid-container]')).toHaveClass('@container');
    expect(container.querySelector('[data-slot=form-grid]')).toHaveClass(
      'grid-cols-1',
      '@xl:grid-cols-2',
      'items-start',
    );
  });

  it('lets a long field span both columns', () => {
    render(
      <FormGrid>
        <Field id="goal" label="Objetivo" span="full">
          <Input />
        </Field>
      </FormGrid>,
    );
    expect(screen.getByLabelText('Objetivo').closest('[data-slot=field]')).toHaveClass(
      'col-span-full',
    );
  });

  it('names a group of fields with a fieldset legend', () => {
    render(
      <FormGrid legend="Operação">
        <Field id="qty" label="Quantidade">
          <Input />
        </Field>
      </FormGrid>,
    );
    expect(screen.getByRole('group', { name: 'Operação' })).toContainElement(
      screen.getByLabelText('Quantidade'),
    );
  });
});

describe('FormPanel', () => {
  it('is a titled panel with the refusal above the fields and the actions in its footer', async () => {
    const { container } = render(
      <form>
        <FormPanel
          title="Aposentadoria"
          description="Nome, descrição, objetivo e cor desta carteira."
          alert={<p role="alert">Recusado.</p>}
          footer={
            <FormActions>
              <Button type="submit">Salvar alterações</Button>
            </FormActions>
          }
        >
          <FormGrid>
            <Field id="name" label="Nome">
              <Input />
            </Field>
          </FormGrid>
        </FormPanel>
      </form>,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Aposentadoria' })).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(
      alert.compareDocumentPosition(screen.getByLabelText('Nome')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.querySelector('[data-slot=section-footer]')).toContainElement(
      screen.getByRole('button', { name: 'Salvar alterações' }),
    );
    expect(await audit(container)).toHaveNoViolations();
  });
});
