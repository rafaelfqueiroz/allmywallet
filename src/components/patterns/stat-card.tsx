import type * as React from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Stack } from '@/components/layout/stack';
import { Skeleton } from '@/components/ui/skeleton';
import { CardLink, type CardLinkTarget } from '@/components/patterns/summary-card';
import { InfoTip } from '@/components/patterns/info-tip';

/**
 * A single headline figure — patrimônio, rentabilidade no período, proventos
 * recebidos. Pass the figure as a `<Money>` so rounding and the sign rule stay
 * in one place; this component owns the framing, never the formatting.
 *
 * Marked up as a description list rather than two stacked paragraphs: `dt`/`dd`
 * is what pairs a label with its value, so a screen reader announces
 * "Patrimônio, R$ 1.234,56" instead of two unrelated fragments. It also avoids
 * needing `useId`, which would force this into a Client Component for nothing.
 */
export type StatCardProps = Omit<React.ComponentProps<typeof Card>, 'title'> & {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Secondary context — a comparison period, a caveat about degraded data. */
  hint?: React.ReactNode;
  /**
   * SPEC-022 BR-022-39 — what the figure measures, behind an info icon beside
   * the label (BR-022-20): open on hover, focus and tap, and the icon's
   * accessible description. `id` must be unique on the page.
   */
  info?: { readonly id: string; readonly text: string };
  /**
   * SPEC-022 BR-022-07 — the destination that owns this figure's detail, as
   * the card's footer row. Pinned to the bottom so a row of cards keeps its
   * links on one line whatever each hint's length, under a hairline that runs
   * edge to edge like every panel's footer (BR-022-36, #243).
   */
  link?: CardLinkTarget;
  /**
   * SPEC-022 BR-022-36 — a figure **inside** a panel: a muted tile with no
   * border of its own, because a card inside a panel is the nested panel the
   * frames never draw. A goal's three figures are this; the Dashboard's
   * headline row, which sits on the page, is not.
   */
  inset?: boolean;
};

export function StatCard({
  label,
  value,
  hint,
  info,
  link,
  inset = false,
  className,
  ...props
}: StatCardProps) {
  return (
    <Card
      data-slot="stat-card"
      data-inset={inset || undefined}
      className={cn('h-full', inset && 'bg-muted/50 ring-0', className)}
      {...props}
    >
      <CardContent className="flex flex-1 flex-col gap-4">
        <dl className="flex-1">
          <Stack gap="xs">
            {info ? (
              <dt className="flex items-center gap-1 text-sm text-muted-foreground">
                <span id={`${info.id}-label`}>{label}</span>
                <InfoTip
                  id={info.id}
                  label={label}
                  labelledBy={`${info.id}-label`}
                  describedBy={`${info.id}-explanation`}
                >
                  {info.text}
                </InfoTip>
                <span id={`${info.id}-explanation`} hidden>
                  {info.text}
                </span>
              </dt>
            ) : (
              <dt className="text-sm text-muted-foreground">{label}</dt>
            )}
            <dd className="text-2xl font-semibold">{value}</dd>
            {hint && <dd className="text-xs text-muted-foreground">{hint}</dd>}
          </Stack>
        </dl>
      </CardContent>
      {link && (
        <div data-slot="card-footer" className="border-t px-(--card-spacing) py-3">
          <CardLink {...link} />
        </div>
      )}
    </Card>
  );
}

/** The loading shape of a StatCard, so a dashboard does not jump on load. */
export function StatCardSkeleton() {
  return (
    <Card data-slot="stat-card-skeleton" className="h-full">
      <CardContent>
        <Stack gap="xs">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-36" />
        </Stack>
      </CardContent>
    </Card>
  );
}
