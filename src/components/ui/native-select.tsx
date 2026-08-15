import type * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A styled native `<select>`, alongside — not instead of — the Radix `Select`.
 *
 * The two are for different jobs. Radix `Select` is a rich client-side
 * listbox: it needs state, it renders in a portal, and it does not put a value
 * into a native form submission without a hidden mirror input. Every select on
 * the retrofitted screens lives inside a `<form action={serverAction}>` that
 * posts without JavaScript, so a native element is the correct one — and on a
 * phone it opens the platform picker, which is better than anything a portal
 * can imitate.
 *
 * Reach for Radix `Select` when the control drives client state; reach for
 * this when it is a form field.
 */
export function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-field text-sm outline-none',
        'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
        'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20',
        'dark:bg-input/30',
        className,
      )}
      {...props}
    />
  );
}
