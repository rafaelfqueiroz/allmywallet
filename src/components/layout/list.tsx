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
    /**
     * An item a link elsewhere points at (`#id`) — the Painel's "Ver regra",
     * an e-mail's link to a rule (#212). It clears the top bar when scrolled
     * to. The ring follows CSS `:target`, which a full page load sets (the
     * e-mail) and a client-side navigation does not (the Painel's `Link`, whose
     * `pushState` leaves `:target` alone): there the scroll alone shows it.
     */
    linkTarget: {
      true: 'scroll-mt-20 rounded-md target:ring-2 target:ring-ring target:ring-offset-4 target:ring-offset-background',
      false: '',
    },
  },
  defaultVariants: { separated: false, linkTarget: false },
});

export type ListProps = Omit<React.ComponentProps<'ul'>, 'ref'> &
  VariantProps<typeof listVariants> & {
    /**
     * `ol` when the order is part of the meaning — a sequence of steps a user
     * has to perform in order. A screen reader announces the two differently
     * ("list" versus "ordered list, item 2 of 3"), and instructions rendered as
     * an unordered list quietly drop the one thing that made them
     * instructions.
     *
     * `ref` is omitted from the props above because the element type is chosen
     * at the call site and `ul` and `ol` do not share a ref type — the same
     * reasoning `Text` records for its own polymorphic `as`.
     */
    as?: 'ul' | 'ol';
  };

export function List({ className, gap, as: Component = 'ul', ...props }: ListProps) {
  return <Component data-slot="list" className={cn(listVariants({ gap }), className)} {...props} />;
}

export type ListItemProps = React.ComponentProps<'li'> & VariantProps<typeof listItemVariants>;

export function ListItem({ className, separated, linkTarget, ...props }: ListItemProps) {
  return (
    <li
      data-slot="list-item"
      className={cn(listItemVariants({ separated, linkTarget }), className)}
      {...props}
    />
  );
}

export { listVariants, listItemVariants };
