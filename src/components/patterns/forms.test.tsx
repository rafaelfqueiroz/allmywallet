import { describe, expect, it } from 'vitest';
import { Field } from '@/components/patterns/field';
import { Section } from '@/components/patterns/section';
import { AuthShell } from '@/components/patterns/auth-shell';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { NativeSelect } from '@/components/ui/native-select';
import { audit, render, screen } from '@/components/test-utils';

describe('Field', () => {
  it('associates the label with the control it wraps', () => {
    render(
      <Field id="ticker" label="Ativo">
        <Input name="ticker" />
      </Field>,
    );
    expect(screen.getByLabelText('Ativo')).toHaveAttribute('name', 'ticker');
  });

  /*
   * The reason this component exists. Wrapping a control in a `<label>` also
   * works — until a hint is added inside the wrapper, at which point the
   * accessible name silently becomes "Ativo Somente ações", and nobody notices
   * because it still looks right.
   */
  it('attaches the hint as a description, not as part of the name', () => {
    render(
      <Field id="ticker" label="Ativo" hint="Somente ações">
        <Input name="ticker" />
      </Field>,
    );

    const control = screen.getByLabelText('Ativo');
    expect(control).toHaveAccessibleName('Ativo');
    expect(control).toHaveAccessibleDescription('Somente ações');
  });

  it('marks the control invalid and announces the error', () => {
    render(
      <Field id="ticker" label="Ativo" error="Obrigatório">
        <Input name="ticker" />
      </Field>,
    );

    const control = screen.getByLabelText('Ativo');
    expect(control).toHaveAttribute('aria-invalid', 'true');
    expect(control).toHaveAccessibleDescription('Obrigatório');
  });

  it('describes the control by both hint and error when both are present', () => {
    render(
      <Field id="ticker" label="Ativo" hint="Somente ações" error="Obrigatório">
        <Input name="ticker" />
      </Field>,
    );
    expect(screen.getByLabelText('Ativo')).toHaveAccessibleDescription('Somente ações Obrigatório');
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <Field id="ticker" label="Ativo" hint="Somente ações">
        <Input name="ticker" />
      </Field>,
    );
    expect(await audit(container)).toHaveNoViolations();
  });
});

describe('NativeSelect', () => {
  // DS-37: a Radix Select submits nothing in a form that posts without JS.
  it('is a native select, so it participates in a form submission', () => {
    render(
      <form>
        <Field id="wallet" label="Carteira">
          <NativeSelect name="walletId">
            <option value="a">Aposentadoria</option>
          </NativeSelect>
        </Field>
      </form>,
    );

    const control = screen.getByLabelText('Carteira');
    expect(control.tagName).toBe('SELECT');
    expect(control).toHaveAttribute('name', 'walletId');
  });

  it('carries a focus-visible ring', () => {
    render(
      <Field id="wallet" label="Carteira">
        <NativeSelect name="walletId" />
      </Field>,
    );
    expect(screen.getByLabelText('Carteira').className).toContain('focus-visible:ring-ring');
  });
});

describe('Checkbox', () => {
  it('is a native checkbox', () => {
    render(
      <Field id="opt" label="Lembrete">
        <Checkbox name="reminder" />
      </Field>,
    );
    expect(screen.getByLabelText('Lembrete')).toHaveAttribute('type', 'checkbox');
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <Field id="opt" label="Lembrete">
        <Checkbox name="reminder" />
      </Field>,
    );
    expect(await audit(container)).toHaveNoViolations();
  });
});

describe('Section', () => {
  it('renders its title as an h2, correct beneath PageShell’s h1', () => {
    render(<Section title="Carteiras">conteúdo</Section>);
    expect(screen.getByRole('heading', { level: 2, name: 'Carteiras' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <Section title="Carteiras" description="Agrupe por objetivo.">
        conteúdo
      </Section>,
    );
    expect(await audit(container)).toHaveNoViolations();
  });
});

describe('AuthShell', () => {
  it('renders a main landmark with the title as h1', () => {
    render(<AuthShell title="Entrar">conteúdo</AuthShell>);
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Entrar' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <AuthShell title="Entrar" description="Use sua conta Google.">
        conteúdo
      </AuthShell>,
    );
    expect(await audit(container)).toHaveNoViolations();
  });
});
