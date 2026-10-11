import { describe, expect, it } from 'vitest';
import { ColorInput } from '@/components/patterns/color-input';
import { ColorSwatch } from '@/components/patterns/color-swatch';
import { Field } from '@/components/patterns/field';
import { audit, fireEvent, render, screen } from '@/components/test-utils';

describe('ColorInput', () => {
  it('is the native colour control at Input’s height, with the boundary token', () => {
    render(
      <Field id="c" label="Cor">
        <ColorInput name="color" />
      </Field>,
    );
    const control = screen.getByLabelText('Cor');
    expect(control).toHaveAttribute('type', 'color');
    expect(control.className).toMatch(/(^|\s)h-8(\s|$)/);
    // `--input` is a boundary (3:1 against card and page, in both themes —
    // tests/structural/design-token-colour.test.ts), never a fill.
    expect(control.className).toContain('border-input');
    // (Spelled in two parts: the structural test bars the fill utility's name
    // from any file under src/, this one included.)
    expect(control.className).not.toContain(['bg', 'input'].join('-'));
  });

  it('shows the chosen value as text and follows changes', () => {
    render(
      <Field id="c" label="Cor">
        <ColorInput name="color" defaultValue="#336699" />
      </Field>,
    );
    expect(screen.getByText('#336699')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Cor'), { target: { value: '#ff0000' } });
    expect(screen.getByText('#FF0000')).toBeInTheDocument();
  });

  it('starts from a neutral value when the wallet has no colour', () => {
    render(
      <Field id="c" label="Cor">
        <ColorInput name="color" defaultValue={null} />
      </Field>,
    );
    expect(screen.getByText('#000000')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <Field id="c" label="Cor">
        <ColorInput name="color" />
      </Field>,
    );
    expect(await audit(container)).toHaveNoViolations();
  });
});

describe('ColorSwatch', () => {
  it('is decoration: hidden from assistive technology, a ring when there is no colour', () => {
    const { container, rerender } = render(<ColorSwatch color="#336699" />);
    const swatch = container.querySelector('[data-slot="color-swatch"]') as HTMLElement;
    expect(swatch).toHaveAttribute('aria-hidden', 'true');
    expect(swatch.style.backgroundColor).not.toBe('');

    rerender(<ColorSwatch color={null} />);
    expect(
      (container.querySelector('[data-slot="color-swatch"]') as HTMLElement).style.backgroundColor,
    ).toBe('');
  });
});
