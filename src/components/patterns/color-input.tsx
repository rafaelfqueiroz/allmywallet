'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Checkbox } from '@/components/ui/checkbox';

/**
 * A colour control that is visible in both themes (SPEC-022 BR-022-20/22).
 *
 * **Why not a bare `<Input type="color">`.** `Input` is `bg-transparent` with a
 * `px-2.5` and `file:` styling, and a native colour well inside it paints a
 * near-black swatch with no visible edge on a dark card. The control here is
 * the native input — so the platform picker, form posting without JavaScript
 * and keyboard operation are untouched — drawn at `Input`'s own `h-8` with the
 * same `border-input` boundary, which the token table (DESIGN.md §2) pins at 3:1 against both `card` and
 * `background` in both themes (`tests/structural/design-token-colour.test.ts`).
 * `--input` is a boundary, never a fill (DESIGN.md): the dark fill is `muted`,
 * like every other control.
 *
 * **The value is also shown as text** beside the swatch. A colour must not be
 * the only way to read a colour (WCAG 1.4.1): the
 * hex is what a screen reader announces and what a person who cannot tell two
 * blues apart can still compare. It is not a live region: a picker drag would
 * otherwise announce on every pixel.
 *
 * **"Sem cor" is a checkbox beside the swatch** (`noneLabel`), because a native
 * colour input cannot be empty — without it every colourless wallet would be
 * saved black. Checked means "no colour": the form posts `noColor=on` and the
 * server ignores the colour value, so it works without JavaScript. Picking a
 * colour unchecks it. With no `noneLabel` the control is a plain colour input.
 */
export const DEFAULT_COLOR = '#000000';

export type ColorInputProps = Omit<
  React.ComponentProps<'input'>,
  'type' | 'value' | 'defaultValue' | 'onChange'
> & {
  /** The colour to start from; `null` is "no colour" when `noneLabel` is given. */
  defaultValue?: string | null | undefined;
  /** Translated label of the "no colour" checkbox. Present = the colour is optional. */
  noneLabel?: string;
  /** The checkbox's form field. The server reads it before it reads the colour. */
  noneName?: string;
};

export function ColorInput({
  defaultValue,
  noneLabel,
  noneName = 'noColor',
  className,
  ...props
}: ColorInputProps) {
  const optional = noneLabel !== undefined;
  const [value, setValue] = useState(defaultValue ?? DEFAULT_COLOR);
  const [none, setNone] = useState(
    optional && (defaultValue === null || defaultValue === undefined),
  );

  return (
    <span
      data-slot="color-input"
      className="inline-flex h-8 flex-wrap items-center gap-x-3 gap-y-1"
    >
      <input
        {...props}
        type="color"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          // Choosing a colour is the opposite of "no colour".
          setNone(false);
        }}
        data-slot="color-input-control"
        className={cn(
          'h-8 w-12 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-1 outline-none dark:bg-muted',
          'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
          'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
      />
      {!none && (
        <span data-slot="color-input-value" className="text-sm text-muted-foreground tabular-nums">
          {value.toUpperCase()}
        </span>
      )}
      {optional && (
        <label className="inline-flex items-center gap-1.5 text-sm">
          <Checkbox
            name={noneName}
            checked={none}
            onChange={(event) => setNone(event.target.checked)}
          />
          {noneLabel}
        </label>
      )}
    </span>
  );
}
