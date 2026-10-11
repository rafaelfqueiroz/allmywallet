'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * A colour control that is visible in both themes (SPEC-022 BR-022-20/22).
 *
 * **Why not a bare `<Input type="color">`.** `Input` is `bg-transparent` with a
 * `px-2.5` and `file:` styling, and a native colour well inside it paints a
 * near-black swatch with no visible edge on a dark card. The control here is
 * the native input — so the platform picker, form posting without JavaScript
 * and keyboard operation are untouched — drawn at `Input`'s own `h-8` with the
 * same `border-input` boundary, which DS-47 pins at 3:1 against both `card` and
 * `background` in both themes (`tests/structural/design-token-colour.test.ts`).
 * `--input` is a boundary, never a fill (DESIGN.md): the dark fill is `muted`,
 * like every other control.
 *
 * **The value is also shown as text** beside the swatch. A colour must not be
 * the only way to read a colour (WCAG 1.4.1): the
 * hex is what a screen reader announces and what a person who cannot tell two
 * blues apart can still compare. It is not a live region: a picker drag would
 * otherwise announce on every pixel.
 */
export const DEFAULT_COLOR = '#000000';

export type ColorInputProps = Omit<
  React.ComponentProps<'input'>,
  'type' | 'value' | 'defaultValue' | 'onChange'
> & {
  defaultValue?: string | null | undefined;
};

export function ColorInput({ defaultValue, className, ...props }: ColorInputProps) {
  const [value, setValue] = useState(defaultValue ?? DEFAULT_COLOR);

  return (
    <span data-slot="color-input" className="inline-flex items-center gap-2">
      <input
        {...props}
        type="color"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        data-slot="color-input-control"
        className={cn(
          'h-8 w-12 shrink-0 cursor-pointer rounded-lg border border-input bg-transparent p-1 outline-none dark:bg-muted',
          'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
          'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
      />
      <span data-slot="color-input-value" className="text-sm text-muted-foreground tabular-nums">
        {value.toUpperCase()}
      </span>
    </span>
  );
}
