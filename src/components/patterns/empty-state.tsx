import type * as React from 'react';
import { cn } from '@/lib/utils';
import { Stack } from '@/components/layout/stack';

/**
 * SPEC-011 — a report with no data explains itself; it never shows a
 * misleading zero. "R$ 0,00" and "we have no data for this period" look
 * identical on a screen and mean opposite things to someone checking their
 * portfolio, so the distinction is a component rather than a convention.
 *
 * `role="status"` so the explanation is announced when a filter change empties
 * the view, rather than the user hearing silence and assuming a hang.
 */
export type EmptyStateProps = React.ComponentProps<'div'> & {
  /** Why there is nothing here. Translated text — AR-44. */
  title: React.ReactNode;
  description?: React.ReactNode;
  /** What the user can do about it, if anything. */
  action?: React.ReactNode;
  icon?: React.ReactNode;
};

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      role="status"
      className={cn('rounded-xl border border-dashed px-6 py-10 text-center', className)}
      {...props}
    >
      <Stack gap="sm" align="center">
        {icon && (
          <span aria-hidden="true" className="text-muted-foreground [&_svg]:size-6">
            {icon}
          </span>
        )}
        <p className="font-medium">{title}</p>
        {description && <p className="max-w-prose text-sm text-muted-foreground">{description}</p>}
        {action}
      </Stack>
    </div>
  );
}
