import type * as React from 'react';
import { cn } from '@/lib/utils';
import { Stack } from '@/components/layout/stack';

/**
 * A titled region within a page. The wallets screen alone has five, and every
 * one of them was `<section><div><h2/><p/></div>…</section>` written out by
 * hand, with the heading level and the description styling re-decided each
 * time.
 *
 * `title` renders as `h2`, which is correct under `PageShell`'s `h1`. Nesting
 * deeper is a signal the page is doing too much, not a reason to add a level
 * prop.
 */
export type SectionProps = React.ComponentProps<'section'> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Controls aligned with the heading. */
  actions?: React.ReactNode;
};

export function Section({
  title,
  description,
  actions,
  children,
  className,
  ...props
}: SectionProps) {
  return (
    <section data-slot="section" className={cn('w-full', className)} {...props}>
      <Stack gap="md">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <Stack gap="xs">
            <h2 className="text-lg font-medium">{title}</h2>
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </Stack>
          {actions}
        </div>
        {children}
      </Stack>
    </section>
  );
}
