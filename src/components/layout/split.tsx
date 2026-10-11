import type * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * A fixed-width column beside a fluid one, stacked on a narrow container.
 *
 * Two shapes recur in Configurações (SPEC-022 BR-022-16): a section
 * sub-navigation beside its content (`side="start"`), and a list beside the
 * form that edits it (`side="end"`, the prototype's "Nova carteira" panel). DS-22
 * bars `grid-cols-[…]` in `src/app/`, so the shape is a component, and `Grid`'s
 * equal columns cannot express "one column has a width, the other takes the
 * rest".
 *
 * **The breakpoint is the container's, not the viewport's.** The content column
 * of a page that already has a sub-navigation is narrower than the viewport by
 * the application sidebar and the sub-navigation both, so a viewport breakpoint
 * would put a table and a form side by side in 360px. A container query splits
 * only when the room is really there, and it nests: the panel split lives
 * inside the content column of the navigation split. Below the breakpoint it is
 * one column and the mobile case is the default (DL-12).
 *
 * `min-w-0` on the fluid column's track (`minmax(0,1fr)`) is what lets a wide
 * table scroll inside its own container instead of widening the page.
 */
const splitVariants = cva('grid grid-cols-1 items-start', {
  variants: {
    side: {
      /** The fixed column first — a sub-navigation. */
      start: '@2xl:grid-cols-[14rem_minmax(0,1fr)]',
      /** The fixed column last — a panel beside a list. */
      end: '@3xl:grid-cols-[minmax(0,1fr)_20rem]',
    },
    gap: {
      md: 'gap-4',
      lg: 'gap-6',
    },
  },
  defaultVariants: { side: 'end', gap: 'lg' },
});

export type SplitProps = React.ComponentProps<'div'> & VariantProps<typeof splitVariants>;

export function Split({ className, side, gap, ...props }: SplitProps) {
  return (
    <div data-slot="split-container" className="@container w-full">
      <div
        data-slot="split"
        className={cn(splitVariants({ side, gap }), className)}
        {...props}
      />
    </div>
  );
}

export { splitVariants };
