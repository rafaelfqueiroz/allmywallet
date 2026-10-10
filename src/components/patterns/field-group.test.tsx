import { describe, expect, it } from 'vitest';
import { FieldGroup } from '@/components/patterns/field-group';
import { Checkbox } from '@/components/ui/checkbox';
import { audit, render, screen } from '@/components/test-utils';

/** SPEC-022 BR-022-20/21 for a group of controls — `Field`'s contract on a fieldset. */
function group(error?: string) {
  return render(
    <FieldGroup id="bench" legend="Benchmarks" hint="Índices exibidos." error={error}>
      <Checkbox id="bench-cdi" name="value" value="CDI" aria-label="CDI" />
    </FieldGroup>,
  );
}

describe('FieldGroup', () => {
  it('is named by its legend alone, with the hint behind an icon and in the description', () => {
    const { container } = group();
    const fieldset = screen.getByRole('group', { name: 'Benchmarks' });
    expect(fieldset).toHaveAccessibleDescription('Índices exibidos.');
    expect(screen.getByRole('button', { name: /Instruções sobre/ })).toBeInTheDocument();
    expect(container.querySelector('p')).toBeNull();
  });

  it('renders an error inline and marks the group invalid (BR-022-21)', () => {
    group('Valor não aceito.');
    const fieldset = screen.getByRole('group', { name: 'Benchmarks' });
    expect(screen.getByText('Valor não aceito.')).toBeVisible();
    expect(fieldset).toHaveAttribute('aria-invalid', 'true');
    expect(fieldset).toHaveAccessibleDescription('Índices exibidos. Valor não aceito.');
  });

  it('has no accessibility violations', async () => {
    const { container } = group('Valor não aceito.');
    expect(await audit(container)).toHaveNoViolations();
  });
});
