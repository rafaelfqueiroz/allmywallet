import type * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Responsive columns. Every variant starts at one column and widens at `sm`
 * and `lg` — the mobile case is the default rather than an override, so a
 * caller cannot produce a four-column grid on a phone by forgetting a
 * breakpoint (DL-12).
 */
const gridVariants = cva('grid', {
  variants: {
    cols: {
      1: 'grid-cols-1',
      2: 'grid-cols-1 sm:grid-cols-2',
      3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
      4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
    },
    gap: {
      none: 'gap-0',
      sm: 'gap-2',
      md: 'gap-4',
      lg: 'gap-6',
    },
  },
  defaultVariants: { cols: 2, gap: 'md' },
});

export type GridProps = React.ComponentProps<'div'> & VariantProps<typeof gridVariants>;

export function Grid({ className, cols, gap, ...props }: GridProps) {
  return <div data-slot="grid" className={cn(gridVariants({ cols, gap }), className)} {...props} />;
}

export { gridVariants };
