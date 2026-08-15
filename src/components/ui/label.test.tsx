import { describe, expect, it } from 'vitest';
import { Label } from '@/components/ui/label';
import { audit, render, screen } from '@/components/test-utils';

describe('Label', () => {
  it('associates with its control', () => {
    render(
      <>
        <Label htmlFor="quantidade">Quantidade</Label>
        <input id="quantidade" />
      </>,
    );
    expect(screen.getByLabelText('Quantidade')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <>
        <Label htmlFor="quantidade">Quantidade</Label>
        <input id="quantidade" />
      </>,
    );
    expect(await audit(container)).toHaveNoViolations();
  });
});
