import type * as React from 'react';
import { CircleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Stack } from '@/components/layout/stack';

/**
 * The counterpart to EmptyState, and deliberately a different component:
 * "there is nothing here" and "we could not load this" must never render the
 * same, because only one of them is worth retrying.
 *
 * `role="alert"` rather than `status` — a failure interrupts; an empty result
 * does not.
 *
 * AR-44/AR-45: `title` and `description` take already-translated text. Domain
 * code produces error *codes*; the `errors.*` catalogue renders them.
 */
export type ErrorStateProps = React.ComponentProps<'div'> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** A retry control, when retrying is meaningful. */
  action?: React.ReactNode;
};

export function ErrorState({ title, description, action, className, ...props }: ErrorStateProps) {
  return (
    <div
      data-slot="error-state"
      role="alert"
      className={cn(
        'rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-8 text-center',
        className,
      )}
      {...props}
    >
      <Stack gap="sm" align="center">
        <CircleAlert aria-hidden="true" className="size-6 text-destructive" />
        <p className="font-medium">{title}</p>
        {description && <p className="max-w-prose text-sm text-muted-foreground">{description}</p>}
        {action}
      </Stack>
    </div>
  );
}
