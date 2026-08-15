import type * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * A vertical list that keeps its list semantics.
 *
 * `Stack` cannot do this job: wrapping `<li>` elements in a `<div>` to get a
 * gap breaks the `ul`/`li` relationship a screen reader announces ("list, four
 * items"), which is the same class of mistake axe caught in `DataTable`'s
 * `dl`. So the gap lives on the `ul` itself.
 *
 * `separated` folds together the three literals that always travelled together
 * on these screens — `border-b`, a bottom padding, and `last:border-0`.
 */
const listVariants = cva('flex flex-col', {
  variants: {
    gap: {
      none: 'gap-0',
      sm: 'gap-2',
      md: 'gap-4',
      lg: 'gap-6',
    },
  },
  defaultVariants: { gap: 'sm' },
});

const listItemVariants = cva('', {
  variants: {
    separated: {
      /** A hairline between items, suppressed after the last one. */
      true: 'border-b pb-4 last:border-0 last:pb-0',
      false: '',
    },
  },
  defaultVariants: { separated: false },
});

export type ListProps = React.ComponentProps<'ul'> & VariantProps<typeof listVariants>;

export function List({ className, gap, ...props }: ListProps) {
  return <ul data-slot="list" className={cn(listVariants({ gap }), className)} {...props} />;
}

export type ListItemProps = React.ComponentProps<'li'> & VariantProps<typeof listItemVariants>;

export function ListItem({ className, separated, ...props }: ListItemProps) {
  return (
    <li
      data-slot="list-item"
      className={cn(listItemVariants({ separated }), className)}
      {...props}
    />
  );
}

export { listVariants, listItemVariants };
