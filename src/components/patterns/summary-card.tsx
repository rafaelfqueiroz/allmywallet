import type * as React from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';

/**
 * The destination that owns a card's detail (SPEC-022 BR-022-07).
 *
 * `ariaLabel` names the destination when the visible label alone would be
 * ambiguous among several cards — two cards reading "Ver no Portfólio" are two
 * links with one name, which a screen reader's link list cannot tell apart.
 */
export interface CardLinkTarget {
  readonly href: string;
  readonly label: string;
  readonly ariaLabel?: string;
}

/**
 * The link at the foot of a card: a full-width row under a hairline, the label
 * flush with the card's own left edge and a chevron at the right — the
 * prototype's "Ver no Portfólio ›" (DL-022-13).
 *
 * **Not `Button variant="link"`.** That button carries its own horizontal
 * padding, so on the owner's screen every "Ver o relatório…" link sat indented
 * off the left edge of the heading above it (#213). A link that is a row has
 * no padding of its own; the card's content padding is the only inset.
 */
export function CardLink({ href, label, ariaLabel }: CardLinkTarget) {
  return (
    <div data-slot="card-link" className="border-t pt-3">
      <Link
        href={href}
        {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
        className="flex items-center justify-between gap-2 rounded-sm text-sm text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span>{label}</span>
        <ChevronRight aria-hidden className="size-4 shrink-0" />
      </Link>
    </div>
  );
}

/**
 * A link aligned with a card's heading — the watch card's "Regras". Like
 * `CardLink`, no padding of its own, so it sits on the header's right edge.
 */
export function CardHeaderLink({ href, label, ariaLabel }: CardLinkTarget) {
  return (
    <Link
      href={href}
      {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
      className="rounded-sm text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {label}
    </Link>
  );
}

/**
 * A card that is a **section of the page**: a heading, an optional badge or
 * action beside it, the content, and the link to the destination that owns
 * the detail (SPEC-022 BR-022-07 — "each card links to the destination that
 * owns its detail"). The Painel is built from these.
 *
 * Its own `section` with an `h2`, which is correct under `PageShell`'s `h1`
 * (DS-38): a Painel card is a region of the document, not a label inside one.
 * `StatCard` is the other shape — a single figure, whose label is not a
 * heading.
 *
 * `badge` is for status (a `Badge` with a status variant, BR-022-31) or a
 * count; `action` for a link aligned with the heading ("Regras").
 */
export type SummaryCardProps = Omit<React.ComponentProps<'section'>, 'title'> & {
  title: React.ReactNode;
  badge?: React.ReactNode;
  action?: React.ReactNode;
  link?: CardLinkTarget;
};

export function SummaryCard({
  title,
  badge,
  action,
  link,
  children,
  className,
  ...props
}: SummaryCardProps) {
  return (
    <Card className={cn('gap-0 py-0', className)}>
      <section data-slot="summary-card" className="flex flex-col" {...props}>
        <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <h2 className="text-base font-medium">{title}</h2>
          {(badge || action) && (
            <div className="flex items-center gap-2">
              {badge}
              {action}
            </div>
          )}
        </header>
        <div className="flex flex-col gap-4 p-4">
          <div>{children}</div>
          {link && <CardLink {...link} />}
        </div>
      </section>
    </Card>
  );
}
