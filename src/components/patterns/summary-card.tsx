import type * as React from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { Section } from '@/components/patterns/section';

/**
 * The destination that owns a card's detail (SPEC-022 BR-022-07).
 *
 * `ariaLabel` names the destination when the visible label alone would be
 * ambiguous among several cards — two cards reading "Ver no Portfólio" are two
 * links with one name, which a screen reader's link list cannot tell apart.
 * It must **begin with the visible label** (WCAG 2.5.3, label in name), or a
 * voice-control user saying what they see matches nothing; one that does not
 * is dropped and the visible label stays the name (`accessibleName`).
 */
export interface CardLinkTarget {
  readonly href: string;
  readonly label: string;
  readonly ariaLabel?: string;
}

/**
 * The link at the foot of a card: the label flush with the card's own left
 * edge and a chevron at the right — the prototype's "Ver no Portfólio ›"
 * (DL-022-13). The card draws the hairline above it: a panel's footer runs
 * edge to edge (BR-022-36, #243), so the row is the footer's, not the link's.
 *
 * **Not `Button variant="link"`.** That button carries its own horizontal
 * padding, so on the owner's screen every "Ver o relatório…" link sat indented
 * off the left edge of the heading above it (#213). A link that is a row has
 * no padding of its own; the footer's padding, the same as the header's, is
 * the only inset.
 */
function accessibleName(label: string, ariaLabel: string | undefined) {
  return ariaLabel?.startsWith(label) ? { 'aria-label': ariaLabel } : {};
}

export function CardLink({ href, label, ariaLabel }: CardLinkTarget) {
  return (
    <Link
      data-slot="card-link"
      href={href}
      {...accessibleName(label, ariaLabel)}
      className="flex items-center justify-between gap-2 rounded-sm text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <span>{label}</span>
      <ChevronRight aria-hidden className="size-4 shrink-0" />
    </Link>
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
      {...accessibleName(label, ariaLabel)}
      className="rounded-sm text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {label}
    </Link>
  );
}

/**
 * An item's own name as the link to its detail, inside a card — the watch
 * card's asset code, which opens its rule (#243). It keeps the text's colour
 * and weight, as the frame draws a table's first column, and shows itself a
 * link on hover and focus. Like the links above, no padding of its own, and
 * the same label-in-name rule for `ariaLabel` (WCAG 2.5.3).
 *
 * A line of its own (`data-cell-line`, an inline block): in a table cell too
 * narrow for it, it ends in an ellipsis with the cell's tooltip (DS-67) and
 * its box stays inside the cell, so a pointer on the next column never lands
 * on it; anywhere else it wraps like text. Its focus ring is drawn **inside**
 * its box (`ring-inset`): the cell clips at the link's own edges, so a ring
 * outside them was cut to a sliver (WCAG 2.4.7, #243 review).
 */
export function CardItemLink({ href, label, ariaLabel }: CardLinkTarget) {
  return (
    <Link
      href={href}
      {...accessibleName(label, ariaLabel)}
      data-cell-line
      className="inline-block max-w-full rounded-sm align-bottom font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      {label}
    </Link>
  );
}

/**
 * A card that is a **section of the page**: a heading, an optional badge or
 * action beside it, the content, and the link to the destination that owns
 * the detail (SPEC-022 BR-022-07 — "each card links to the destination that
 * owns its detail"). The Dashboard is built from these.
 *
 * A `Section` panel (BR-022-36, DS-38): the header above a hairline, the body,
 * and the link as the panel's **footer**, under a hairline that runs edge to
 * edge as the frame draws it (#243). Being the panel itself is also what lets
 * a table inside it align its own edges with the card's.
 *
 * Its own `section` with an `h2`, which is correct under `PageShell`'s `h1`
 * (DS-38): a Dashboard card is a region of the document, not a label inside
 * one. `StatCard` is the other shape — a single figure, whose label is not a
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

export function SummaryCard({ title, badge, action, link, children, ...props }: SummaryCardProps) {
  return (
    <Section
      {...props}
      data-slot="summary-card"
      title={title}
      actions={
        badge || action ? (
          <div className="flex items-center gap-2">
            {badge}
            {action}
          </div>
        ) : undefined
      }
      footer={link ? <CardLink {...link} /> : undefined}
    >
      {children}
    </Section>
  );
}
