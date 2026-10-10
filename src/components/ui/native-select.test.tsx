import type * as React from 'react';
import { describe, expect, it } from 'vitest';
import { NativeSelect } from '@/components/ui/native-select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { audit, render, screen, userEvent } from '@/components/test-utils';

function Labelled(props: React.ComponentProps<typeof NativeSelect>) {
  return (
    <>
      <Label htmlFor="periodo">Período</Label>
      <NativeSelect id="periodo" {...props}>
        <option value="12m">Últimos 12 meses</option>
        <option value="ytd">Ano atual</option>
      </NativeSelect>
    </>
  );
}

describe('NativeSelect', () => {
  it('is a native select reachable by its label', () => {
    render(<Labelled />);
    expect(screen.getByLabelText('Período').tagName).toBe('SELECT');
  });

  it('changes value with the keyboard', async () => {
    const user = userEvent.setup();
    render(<Labelled />);
    await user.selectOptions(screen.getByLabelText('Período'), 'ytd');
    expect(screen.getByLabelText('Período')).toHaveValue('ytd');
  });

  // BR-022-22 / #217 — jsdom has no layout, so the clipping cannot be measured
  // here; what can be pinned is the height/padding pair that caused it. 32px
  // minus the border leaves room for a 20px line only with 4px padding, not the
  // 10px `py-field` it used to carry.
  it('keeps the height and vertical padding that fit a full text line', () => {
    render(<Labelled />);
    const classes = screen.getByLabelText('Período').className.split(/\s+/);
    expect(classes).toContain('h-8');
    expect(classes).toContain('py-1');
    expect(classes).toContain('leading-5');
    expect(classes).not.toContain('py-field');
  });

  it('shares its height and vertical padding with Input so a row aligns', () => {
    render(
      <>
        <Labelled />
        <Input aria-label="Texto" />
      </>,
    );
    const select = screen.getByLabelText('Período').className.split(/\s+/);
    const input = screen.getByLabelText('Texto').className.split(/\s+/);
    for (const cls of ['h-8', 'py-1']) {
      expect(input).toContain(cls);
      expect(select).toContain(cls);
    }
  });

  it('reserves room for the chevron so long values do not run under it', () => {
    render(<Labelled />);
    expect(screen.getByLabelText('Período').className).toContain('pr-8');
  });

  it('carries a focus-visible ring', () => {
    render(<Labelled />);
    expect(screen.getByLabelText('Período').className).toContain('focus-visible:ring-ring');
  });

  it('exposes the invalid state beyond colour', () => {
    render(<Labelled aria-invalid />);
    const select = screen.getByLabelText('Período');
    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(select.className).toContain('aria-invalid:border-destructive');
  });

  it('applies className to the wrapper, so a caller cannot reintroduce clipping', () => {
    const { container } = render(<Labelled className="w-fit" />);
    const wrapper = container.querySelector('[data-slot="native-select-wrapper"]');
    expect(wrapper?.className).toContain('w-fit');
    expect(screen.getByLabelText('Período').className).not.toContain('w-fit');
  });

  it('draws a decorative chevron that does not intercept the pointer', () => {
    const { container } = render(<Labelled />);
    const chevron = container.querySelector('svg');
    expect(chevron).toHaveAttribute('aria-hidden', 'true');
    expect(chevron?.getAttribute('class')).toContain('pointer-events-none');
  });

  it('has no axe violations, enabled, disabled or invalid', async () => {
    for (const props of [{}, { disabled: true }, { 'aria-invalid': true as const }]) {
      const { container, unmount } = render(<Labelled {...props} />);
      expect(await audit(container)).toHaveNoViolations();
      unmount();
    }
  });
});
