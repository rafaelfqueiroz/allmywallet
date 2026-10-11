import { cn } from '@/lib/utils';

/**
 * A share of a whole as a horizontal bar — the Portfólio › Patrimônio class
 * cards' (SPEC-022 BR-022-02, the approved prototype).
 *
 * **Decoration for a figure printed beside it**, so it is `aria-hidden`: the
 * percentage is already text, and a `progressbar` or `meter` would announce
 * the same number twice under a role that promises a task in progress or a
 * gauge with a range. A bar without its figure is not a valid use.
 *
 * `percent` is a CSS percentage **string**, produced on the server from the
 * exact decimal (`Money.times('100').toString()`), so no float stands between
 * the figure and the bar (AR-06). The colour is the series colour from
 * `palette.ts` — the same `var(--chart-N)` / asset-class token the legend and
 * the swatch use, so a bar and its label never disagree. The track is the
 * muted surface, at a 6px height the prototype draws.
 *
 * A share is a proportion, not an amount, so the bar stays when values are
 * masked (SPEC-022 BR-022-24).
 */
export function ShareBar({
  percent,
  color,
  className,
}: {
  /** e.g. `'48.4'` — a number without the `%`. */
  readonly percent: string;
  /** A `var(--chart-N)` reference from palette.ts, never a literal colour. */
  readonly color: string;
  readonly className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      data-slot="share-bar"
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}
    >
      <div
        className="h-full rounded-full"
        style={{ width: `${percent}%`, backgroundColor: color }}
      />
    </div>
  );
}
