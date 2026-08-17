import type * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A standing statement about how the figures above it were produced — not a
 * transient alert, and never an action.
 *
 * **Why this is a component rather than a `<p className="text-sm">`.** The
 * disclosures this carries are the ones a regulator or a mistrustful user goes
 * looking for: *these values deduct no tax*, *part of this is accrued rather
 * than observed*. A note that renders differently on each of four reports
 * reads as decoration on three of them, and a disclosure that reads as
 * decoration has not been made.
 *
 * `role="note"` rather than `role="alert"` or `status`: nothing here is new,
 * urgent, or the result of something the user just did. An alert would
 * interrupt a screen-reader user on every render of a page whose disclosure
 * has not changed since the last one.
 */
export type NoteProps = React.ComponentProps<'div'> & {
  /** Translated text — AR-44 bars string literals in components. */
  children: React.ReactNode;
};

export function Note({ children, className, ...props }: NoteProps) {
  return (
    <div
      data-slot="note"
      role="note"
      className={cn(
        'rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground',
        'max-w-prose',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
