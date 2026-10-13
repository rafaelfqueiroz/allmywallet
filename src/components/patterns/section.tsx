import * as React from 'react';
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
 *
 * SPEC-022 BR-022-36 — "every block of content sits in a panel: a bordered
 * surface with a header holding its title and actions, and an optional footer
 * for pagination, a link or actions." So a `Section` **is** a panel by
 * default: an 8px card surface, the title and `actions` on a header row above
 * a hairline, the body, and `footer` under another hairline. Every caller
 * became a panel without changing a line.
 *
 * `variant="plain"` is the old open region — a heading on the page background
 * — for the two places where drawing a border would be wrong: a section that
 * already sits inside a panel (a second border inside the first is the nested
 * panel the frames never draw), and a section whose content is itself a group
 * of panels, such as Portfólio's class cards, where the cards are the panels.
 */
export type SectionProps = Omit<React.ComponentProps<'section'>, 'title'> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Controls aligned with the heading. */
  actions?: React.ReactNode;
  /** Pagination, a link or actions, under a hairline. A panel's only. */
  footer?: React.ReactNode;
  variant?: 'panel' | 'plain';
};

export function Section({
  title,
  description,
  actions,
  footer,
  variant = 'panel',
  children,
  className,
  ...props
}: SectionProps) {
  const heading = (
    <Stack gap="xs">
      <h2 className={variant === 'panel' ? 'text-base font-medium' : 'text-lg font-medium'}>
        {title}
      </h2>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </Stack>
  );

  if (variant === 'plain') {
    return (
      <section
        data-slot="section"
        data-variant="plain"
        className={cn('w-full', className)}
        {...props}
      >
        <Stack gap="md">
          <div className="flex flex-wrap items-start justify-between gap-2">
            {heading}
            {actions}
          </div>
          {children}
        </Stack>
      </section>
    );
  }

  return (
    <section
      data-slot="section"
      data-variant="panel"
      className={cn(
        'group/panel flex w-full min-w-0 flex-col rounded-lg bg-card text-card-foreground ring-1 ring-foreground/10',
        className,
      )}
      {...props}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        {heading}
        {actions}
      </header>
      {/* A panel whose content is all conditional — an import batch still
          parsing has no counts yet — is a header and a footer, not an empty
          padded band between them. */}
      {React.Children.toArray(children).length > 0 && (
        <Stack gap="md" className="min-w-0 p-4">
          {children}
        </Stack>
      )}
      {footer && (
        <footer data-slot="section-footer" className="border-t px-4 py-3 text-sm">
          {footer}
        </footer>
      )}
    </section>
  );
}
