import type * as React from 'react';
import { Stack } from '@/components/layout/stack';
import { PageHeader } from '@/components/patterns/page-header';

/**
 * SPEC-022 BR-022-14 — **one page width, and a page never chooses its own.**
 *
 * #33 replaced five accidental max-widths with three named ones (`narrow`,
 * `default`, `wide`). That stopped the drift but kept the choice, and the
 * choice is what the 2026-10-09 walkthrough measured: Relatórios began about
 * 426px from the edge and Painel about 574px, because each screen picked a
 * different width and `mx-auto` centred it. Peer destinations whose left edge
 * moves as you switch between them read as different products.
 *
 * So there is no width prop. Every destination starts at the same left edge
 * and stops at the same maximum width (`max-w-7xl`, the old `wide`, which the
 * reports, tables and the approved prototype all need). A form or a paragraph
 * that wants a shorter measure constrains *itself* — `Field` widths,
 * `max-w-prose` in `EmptyState` — without moving the page's edge.
 *
 * Pages outside the application frame have their own shells (DS-39):
 * `AuthShell` for a single centred task, `MarketingShell` for public pages.
 * A structural test (`tests/structural/one-page-width.test.ts`) bars a page in
 * `(app)`/`(settings)` from setting a width of its own, and an E2E journey
 * measures the rendered edge on every destination.
 */
const PAGE_SHELL_CLASSES = 'mx-auto w-full max-w-7xl px-4 py-6 sm:px-8 sm:py-8';

// No `className` either: it was the way back to a per-page width.
export type PageShellProps = Omit<React.ComponentProps<'main'>, 'className'> & {
  /** Rendered as the page's <h1>. Pass translated text — AR-44. */
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Buttons or filters aligned with the title on wide screens. */
  actions?: React.ReactNode;
  /** The scope selector (BR-022-17), passed through to the header. */
  scope?: React.ReactNode;
};

export function PageShell({
  title,
  description,
  actions,
  scope,
  children,
  ...props
}: PageShellProps) {
  return (
    <main data-slot="page-shell" className={PAGE_SHELL_CLASSES} {...props}>
      <Stack gap="lg">
        {/* BR-022-14: the header is `PageHeader`'s, so there is one of them. */}
        {(title || description || actions || scope) && (
          <PageHeader
            {...(title ? { title } : {})}
            {...(description ? { description } : {})}
            {...(actions ? { actions } : {})}
            {...(scope ? { scope } : {})}
          />
        )}
        {children}
      </Stack>
    </main>
  );
}
