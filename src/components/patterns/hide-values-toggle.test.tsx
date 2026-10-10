import { describe, expect, it, vi } from 'vitest';
import { HideValuesToggle } from '@/components/patterns/hide-values-toggle';
import { RevealValuesForm } from '@/components/patterns/reveal-values-form';
import { MaskingProvider, MaskingSync } from '@/components/patterns/masking';
import { audit, render, screen } from '@/components/test-utils';

const action = vi.fn(async (_formData: FormData) => {});

/** The toggle as the frame renders it: inside the provider the layout seeds. */
function Toggle({ masked }: { masked: boolean }) {
  return (
    <MaskingProvider masked={masked}>
      <HideValuesToggle action={action} />
    </MaskingProvider>
  );
}

describe('HideValuesToggle (SPEC-022 BR-022-24)', () => {
  it('exposes the state as aria-pressed under one constant name', () => {
    const { rerender } = render(<Toggle masked={false} />);
    expect(screen.getByRole('button', { name: 'Ocultar valores' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    rerender(<Toggle masked />);
    expect(screen.getByRole('button', { name: 'Ocultar valores' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  // The server applies masking, so the form carries the state it asks for
  // rather than a "flip" the server would have to resolve against a value the
  // page may have rendered from before another tab changed it.
  it('submits the opposite of the state it was rendered with', () => {
    const { container, rerender } = render(<Toggle masked={false} />);
    const field = () => container.querySelector<HTMLInputElement>('input[name="hidden"]');
    expect(field()?.value).toBe('true');

    rerender(<Toggle masked />);
    expect(field()?.value).toBe('false');
  });

  /**
   * A client-side navigation re-renders the page and not the layout. The page
   * reports the masking it was rendered with, and the eye follows it rather
   * than the stale value the layout read (the PR #222 review).
   */
  it('follows the page it sits over, not the layout that seeded it', () => {
    render(
      <MaskingProvider masked={false}>
        <HideValuesToggle action={action} />
        <MaskingSync masked />
      </MaskingProvider>,
    );

    expect(screen.getByRole('button', { name: 'Ocultar valores' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('passes axe in both states', async () => {
    const off = render(<Toggle masked={false} />);
    expect(await audit(off.container)).toHaveNoViolations();
    off.unmount();

    const on = render(<Toggle masked />);
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
