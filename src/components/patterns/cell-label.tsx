import type { ReactNode } from 'react';
import { Cluster } from '@/components/layout/cluster';
import { Stack } from '@/components/layout/stack';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * SPEC-022 BR-022-18 / DS-67 — a text cell that is a name with something beside
 * it (an estimate badge, a concentration flag): the name ends in an ellipsis
 * when the column is narrow, and the badge keeps its room.
 *
 * Why a component: the cell's own ellipsis cannot reach text inside a flex
 * container, so each line marks itself `data-cell-line` and `truncated-cell.css`
 * truncates it. Written by hand at every call site, that rule was forgotten at
 * three of them.
 *
 * `inline` puts the badge beside the name on one line; `stacked` puts it under.
 * `detail` is a muted second line under the name — the class under a ticker,
 * the broker under an asset — that truncates on its own.
 * The full text, name and badge, opens from the cell on hover and keyboard
 * focus (`TruncatedCell`); a screen reader reads the cell as it stands.
 */
export function CellLabel({
  children,
  badge,
  detail,
  layout = 'inline',
  strong = true,
}: {
  /** The name. Translated or server-formatted text. */
  readonly children: ReactNode;
  readonly badge?: ReactNode;
  /** A muted line under the name. Translated or server-formatted text. */
  readonly detail?: ReactNode;
  readonly layout?: 'inline' | 'stacked';
  /** The name in the medium weight tables use for a row's identity. */
  readonly strong?: boolean;
}) {
  const name = (
    <span data-cell-line className={cn(strong && 'font-medium')}>
      {children}
    </span>
  );

  const second =
    detail === undefined ? null : (
      <Text as="span" size="xs" tone="muted" data-cell-line>
        {detail}
      </Text>
    );

  if (layout === 'stacked') {
    return (
      <Stack gap="xs" align="start" className="max-w-full min-w-0">
        {name}
        {second}
        {badge}
      </Stack>
    );
  }

  const line = (
    <Cluster gap="sm" align="baseline" className="flex-nowrap">
      {name}
      {badge}
    </Cluster>
  );
  return second === null ? (
    line
  ) : (
    <Stack gap="xs" align="start" className="max-w-full min-w-0">
      {line}
      {second}
    </Stack>
  );
}
