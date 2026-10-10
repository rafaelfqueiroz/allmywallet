import type * as React from 'react';
import { ChevronDown } from 'lucide-react';
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
 *
 * **It never clips its own text** (SPEC-022 BR-022-22, #217). The old
 * `h-8` + `py-field` pair left 32 − 2 (border) − 20 (padding) = 10px for a
 * 20px `text-sm` line, so the selected value was cut off. The height and
 * vertical padding are now the same pair `Input` uses — `h-8` with `py-1`,
 * 22px of content box — and the line height is pinned to `leading-5` so the
 * 16px mobile size cannot out-grow it either. That is also what lets a select
 * and an input share a row and line up. A test pins the pair, because jsdom has
 * no layout to catch a regression.
 *
 * The chevron is drawn over a native `appearance-none` select rather than
 * replacing it, so every native behaviour — the platform picker on a phone,
 * form submission without JavaScript — is untouched. `className` goes on the
 * wrapper, which owns the width; the select fills it.
 */
export function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <span
      data-slot="native-select-wrapper"
      className={cn('relative inline-flex w-full min-w-0', className)}
    >
      <select
        data-slot="native-select"
        className={cn(
          'peer h-8 w-full min-w-0 appearance-none rounded-lg border border-input bg-transparent py-1 pr-8 pl-2.5 text-base leading-5 text-ellipsis outline-none md:text-sm',
          'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
          'disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-50',
          'aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20',
          'dark:bg-muted',
        )}
        {...props}
      />
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground peer-disabled:opacity-50"
      />
    </span>
  );
}
