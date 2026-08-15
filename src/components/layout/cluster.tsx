import type * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Horizontal grouping that wraps. The wrapping is the point: a row of filter
 * chips or action buttons that cannot wrap becomes an overflow bug on the
 * first narrow screen, and DL-12 makes narrow screens first-class.
 */
const clusterVariants = cva('flex flex-wrap', {
  variants: {
    gap: {
      none: 'gap-0',
      xs: 'gap-1',
      sm: 'gap-2',
      md: 'gap-4',
      lg: 'gap-6',
    },
    align: {
      start: 'items-start',
      center: 'items-center',
      baseline: 'items-baseline',
      end: 'items-end',
    },
    justify: {
      start: 'justify-start',
      center: 'justify-center',
      between: 'justify-between',
      end: 'justify-end',
    },
  },
  defaultVariants: { gap: 'sm', align: 'center', justify: 'start' },
});

export type ClusterProps = React.ComponentProps<'div'> & VariantProps<typeof clusterVariants>;

export function Cluster({ className, gap, align, justify, ...props }: ClusterProps) {
  return (
    <div
      data-slot="cluster"
      className={cn(clusterVariants({ gap, align, justify }), className)}
      {...props}
    />
  );
}

export { clusterVariants };
