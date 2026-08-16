import type * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Body text with a named tone and size.
 *
 * `text-muted-foreground` was the single most repeated literal left in
 * `src/app/` after the retrofit — ten occurrences of the same colour decision.
 * DS-22 bars it there, and this is where it goes instead.
 *
 * `tone` is semantic, not chromatic: `muted` means secondary information, not
 * grey. Swapping what grey means then happens once.
 */
const textVariants = cva('', {
  variants: {
    tone: {
      default: 'text-foreground',
      muted: 'text-muted-foreground',
      destructive: 'text-destructive',
      positive: 'text-positive',
      negative: 'text-negative',
    },
    size: {
      xs: 'text-xs',
      sm: 'text-sm',
      base: 'text-base',
      lg: 'text-lg',
    },
    weight: {
      normal: 'font-normal',
      medium: 'font-medium',
      semibold: 'font-semibold',
    },
  },
  defaultVariants: { tone: 'default', size: 'sm', weight: 'normal' },
});

/**
 * `ref` is omitted because the element type is chosen at the call site: a
 * `Ref<HTMLParagraphElement>` cannot be handed to a `<legend>`, and there is no
 * useful single type for "whichever of these six it turns out to be". Nothing
 * in this codebase needs a ref to a paragraph.
 */
export type TextProps = Omit<React.ComponentProps<'p'>, 'ref'> &
  VariantProps<typeof textVariants> & {
    /** Render as a different element — `span` inside a sentence, `dd` in a list. */
    as?: 'p' | 'span' | 'div' | 'dd' | 'dt' | 'legend';
  };

export function Text({ className, tone, size, weight, as: Component = 'p', ...props }: TextProps) {
  return (
    <Component
      data-slot="text"
      className={cn(textVariants({ tone, size, weight }), className)}
      {...props}
    />
  );
}

export { textVariants };
