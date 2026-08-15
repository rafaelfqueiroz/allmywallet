import type * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Vertical rhythm. Exists because DS-22 bars raw spacing utilities in
 * `src/app/` — a page says `<Stack gap="lg">`, not `flex flex-col gap-6`, so
 * the set of legal spacings is finite and named.
 */
const stackVariants = cva('flex flex-col', {
  variants: {
    gap: {
      none: 'gap-0',
      xs: 'gap-1',
      sm: 'gap-2',
      md: 'gap-4',
      lg: 'gap-6',
      xl: 'gap-10',
    },
    align: {
      start: 'items-start',
      center: 'items-center',
      end: 'items-end',
      stretch: 'items-stretch',
    },
  },
  defaultVariants: { gap: 'md', align: 'stretch' },
});

export type StackProps = React.ComponentProps<'div'> & VariantProps<typeof stackVariants>;

export function Stack({ className, gap, align, ...props }: StackProps) {
  return (
    <div data-slot="stack" className={cn(stackVariants({ gap, align }), className)} {...props} />
  );
}

export { stackVariants };
