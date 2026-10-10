import { describe, expect, it, vi } from 'vitest';
import { HideValuesToggle } from '@/components/patterns/hide-values-toggle';
import { RevealValuesForm } from '@/components/patterns/reveal-values-form';
import { audit, render, screen } from '@/components/test-utils';

const action = vi.fn(async (_formData: FormData) => {});

describe('HideValuesToggle (SPEC-022 BR-022-24)', () => {
  it('exposes the state as aria-pressed under one constant name', () => {
    const { rerender } = render(<HideValuesToggle masked={false} action={action} />);
    expect(screen.getByRole('button', { name: 'Ocultar valores' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    rerender(<HideValuesToggle masked action={action} />);
    expect(screen.getByRole('button', { name: 'Ocultar valores' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  // The server applies masking, so the form carries the state it asks for
  // rather than a "flip" the server would have to resolve against a value the
  // page may have rendered from before another tab changed it.
  it('submits the opposite of the state it was rendered with', () => {
    const { container, rerender } = render(<HideValuesToggle masked={false} action={action} />);
    const field = () => container.querySelector<HTMLInputElement>('input[name="hidden"]');
    expect(field()?.value).toBe('true');

    rerender(<HideValuesToggle masked action={action} />);
    expect(field()?.value).toBe('false');
  });

  it('passes axe in both states', async () => {
    const off = render(<HideValuesToggle masked={false} action={action} />);
    expect(await audit(off.container)).toHaveNoViolations();
    off.unmount();

    const on = render(<HideValuesToggle masked action={action} />);
    expect(await audit(on.container)).toHaveNoViolations();
  });
});

describe('RevealValuesForm (SPEC-022 BR-022-24)', () => {
  it('says why the form is gone and asks to show values, not to toggle them', async () => {
    const { container } = render(<RevealValuesForm action={action} />);

    expect(screen.getByText(/os valores estão ocultos/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mostrar valores' })).toBeInTheDocument();
    expect(container.querySelector<HTMLInputElement>('input[name="hidden"]')?.value).toBe('false');
    expect(await audit(container)).toHaveNoViolations();
  });
});
