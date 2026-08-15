import type * as React from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Stack } from '@/components/layout/stack';
import { Skeleton } from '@/components/ui/skeleton';

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
};

export function StatCard({ label, value, hint, className, ...props }: StatCardProps) {
  return (
    <Card data-slot="stat-card" className={cn('h-full', className)} {...props}>
      <CardContent>
        <dl>
          <Stack gap="xs">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="text-2xl font-semibold">{value}</dd>
            {hint && <dd className="text-xs text-muted-foreground">{hint}</dd>}
          </Stack>
        </dl>
      </CardContent>
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
