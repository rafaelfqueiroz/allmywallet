import type * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * A fixed-width column beside a fluid one, stacked on a narrow container.
 *
 * Two shapes recur in Configurações (SPEC-022 BR-022-16): a list beside the
 * form that edits it (`side="end"`, the prototype's "Nova carteira" panel), and
 * a task beside its reference (`side="even"`, the upload beside the guide). DS-22
 * bars `grid-cols-[…]` in `src/app/`, so the shape is a component, and `Grid`'s
 * equal columns cannot express "one column has a width, the other takes the
 * rest".
 *
 * **The breakpoint is the container's, not the viewport's.** The content column
 * is narrower than the viewport by the application sidebar (and by any column
 * it is nested in), so a viewport breakpoint would put a table and a form side
 * by side in 360px. A container query splits only when the room is really
 * there, and it nests. Below the breakpoint it is one column and the mobile
 * case is the default (DL-12).
 *
 * `min-w-0` on the fluid column's track (`minmax(0,1fr)`) is what lets a wide
 * table scroll inside its own container instead of widening the page.
 */
const splitVariants = cva('grid grid-cols-1 items-start', {
  variants: {
    side: {
      /** The fixed column last — a panel beside a list. */
      end: '@3xl:grid-cols-[minmax(0,1fr)_20rem]',
      /**
       * No fixed column — a task beside its reference, each half the room
       * (Importar › Enviar: the upload beside the B3 export guide, #211).
       */
      even: '@2xl:grid-cols-2',
      /**
       * A main column beside a narrower one that still holds lists of its
       * own — the Painel's "Precisa da sua atenção" beside the B3 and watch
       * cards (#213, the prototype's 3:2). `end`'s fixed 20rem is a form's
       * width; a list row with a figure, a badge and a link needs more.
       * `@3xl` (48rem of content) splits from a ~1070px viewport beside the
       * sidebar, so a laptop at 125% zoom still gets two columns.
       */
      aside: '@3xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]',
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
      <div data-slot="split" className={cn(splitVariants({ side, gap }), className)} {...props} />
    </div>
  );
}

export { splitVariants };
