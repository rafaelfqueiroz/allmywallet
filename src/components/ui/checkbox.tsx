import type * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A styled native checkbox.
 *
 * Native for the same reason as `NativeSelect`: every checkbox in this product
 * lives inside a `<form action={serverAction}>` that posts without JavaScript,
 * and a Radix checkbox contributes nothing to a native submission without a
 * mirrored hidden input.
 */
export function Checkbox({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type="checkbox"
      data-slot="checkbox"
      className={cn(
        'size-4 shrink-0 rounded-xs border-input accent-primary outline-none',
        'focus-visible:ring-3 focus-visible:ring-ring/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
