import type * as React from 'react';
import { describe, expect, it } from 'vitest';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { audit, render, screen, userEvent } from '@/components/test-utils';

function LabelledInput(props: React.ComponentProps<typeof Input>) {
  return (
    <>
      <Label htmlFor="ticker">PETR4</Label>
      <Input id="ticker" {...props} />
    </>
  );
}

describe('Input', () => {
  it('is reachable by its label', () => {
    render(<LabelledInput />);
    expect(screen.getByLabelText('PETR4')).toBeInTheDocument();
  });

  it('carries a focus-visible ring', () => {
    render(<LabelledInput />);
    expect(screen.getByLabelText('PETR4').className).toContain('focus-visible:ring-ring');
  });

  it('accepts typed input', async () => {
    const user = userEvent.setup();
    render(<LabelledInput />);
    await user.type(screen.getByLabelText('PETR4'), '100');
    expect(screen.getByLabelText('PETR4')).toHaveValue('100');
  });

  it('exposes the invalid state to assistive technology, not just to the eye', () => {
    render(<LabelledInput aria-invalid />);
    expect(screen.getByLabelText('PETR4')).toHaveAttribute('aria-invalid', 'true');
  });

  it('has no axe violations', async () => {
    const { container } = render(<LabelledInput />);
    expect(await audit(container)).toHaveNoViolations();
  });

  it('has no axe violations when unlabelled input is disabled', async () => {
    const { container } = render(<LabelledInput disabled />);
    expect(await audit(container)).toHaveNoViolations();
  });
});
