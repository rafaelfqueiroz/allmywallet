import type * as React from 'react';
import { cn } from '@/lib/utils';
import { Stack } from '@/components/layout/stack';

/**
 * The centred, single-column frame for pages outside the application shell:
 * sign-in today, and whatever else has to work before a user has an account.
 *
 * A separate pattern from `PageShell` rather than a variant of it, because the
 * shapes genuinely differ — `PageShell` is a top-aligned document with a
 * heading and an action bar, this is a viewport-centred card with no
 * navigation. Collapsing them would produce a component whose props
 * contradict each other half the time.
 *
 * It exists at all because DS-22 bars `min-h-dvh items-center justify-center`
 * from `src/app/`: layout that cannot be written as classes has to be
 * available as a component (DS-23).
 */
export type AuthShellProps = React.ComponentProps<'main'> & {
  title: React.ReactNode;
  description?: React.ReactNode;
};

export function AuthShell({ title, description, children, className, ...props }: AuthShellProps) {
  return (
    <main
      data-slot="auth-shell"
      className={cn(
        'mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 text-center',
        className,
      )}
      {...props}
    >
      <Stack gap="lg">
        <Stack gap="sm">
          <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="text-muted-foreground">{description}</p>}
        </Stack>
        {children}
      </Stack>
    </main>
  );
}
