import type * as React from 'react';
import { cn } from '@/lib/utils';
import { Cluster } from '@/components/layout/cluster';
import { Stack } from '@/components/layout/stack';

/**
 * SPEC-022 BR-022-14 — the header every destination renders: the title, the
 * primary actions on the right and, where it applies, the scope selector
 * (BR-022-17).
 *
 * Extracted from `PageShell` so there is one header implementation: before
 * this the heading classes lived inside the frame, and a destination that
 * wanted a header without the frame's width (the dashboard, the reports) could
 * only copy them.
 *
 * The title is the page's `<h1>` — one per page, which is why a destination
 * never renders a second heading of its own at that level. The element is a
 * `header`, which inside `<main>` carries no landmark role of its own, so it
 * adds structure without a second banner.
 *
 * `scope` sits with the actions rather than under the title: it is a control
 * on the page, not a part of its name, and on a narrow screen the right-hand
 * group wraps below the title as one unit.
 */
export type PageHeaderProps = Omit<React.ComponentProps<'header'>, 'title'> & {
  /** Rendered as the page's <h1>. Pass translated text — AR-44. */
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** The scope selector (BR-022-17), for destinations that have one. */
  scope?: React.ReactNode;
  /** Buttons aligned with the title on wide screens. */
  actions?: React.ReactNode;
};

export function PageHeader({
  title,
  description,
  scope,
  actions,
  className,
  ...props
}: PageHeaderProps) {
  return (
    <header data-slot="page-header" className={cn(className)} {...props}>
      <Cluster justify="between" align="start" gap="md">
        <Stack gap="xs">
          {title && <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>}
          {description && <p className="text-muted-foreground">{description}</p>}
        </Stack>
        {(scope || actions) && (
          <Cluster gap="sm">
            {scope}
            {actions}
          </Cluster>
        )}
      </Cluster>
    </header>
  );
}
