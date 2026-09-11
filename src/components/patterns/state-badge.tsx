import type * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * SPEC-018 BR-018-17/DL-018-06 — the buy/hold/sell/unknown badge every watch
 * rule and the Composição holdings table render a state with.
 *
 * **Colour is never the sole carrier (SPEC-016 BR-016-16).** `label` is a
 * required prop, not an optional one: there is no way to construct this
 * element that renders a colour with no accompanying text, because
 * TypeScript refuses to compile a call site that omits it. That is what the
 * spec's acceptance criterion — "an automated check fails the build if a
 * state renders as colour alone" — actually refers to; `state-badge.test.tsx`
 * asserts the text is genuinely present (not just typed as required) for
 * every one of the four states, so the check still catches a regression even
 * if a future edit relaxed the prop back to optional.
 *
 * **Green / yellow / blue, never red (DL-018-06).** `buy`/`hold`/`sell` use
 * three tokens of their own (`--opportunity-buy/hold/sell`, `globals.css`) —
 * never `--positive`/`--negative`, which are about a *figure* (a gain or a
 * loss) and would code a sell as danger, which is usually the opposite of
 * what a sell state means here. `unknown` (BR-018-16) is deliberately muted
 * rather than a fifth colour: "no usable price" is not a fourth opinion to
 * sit alongside buy/hold/sell, so it borrows the same neutral treatment
 * `Badge`'s `secondary` variant already uses elsewhere.
 */
export type WatchState = 'buy' | 'hold' | 'sell' | 'unknown';

const STATE_CLASSES: Readonly<Record<WatchState, string>> = {
  buy: 'bg-opportunity-buy/10 text-opportunity-buy',
  hold: 'bg-opportunity-hold/10 text-opportunity-hold',
  sell: 'bg-opportunity-sell/10 text-opportunity-sell',
  unknown: 'bg-muted text-muted-foreground',
};

export interface StateBadgeProps {
  readonly state: WatchState;
  /** Translated text (AR-44) — never optional. See the module doc comment above. */
  readonly label: string;
  /** An accessible, translated explanation shown on hover/focus — never the recommendation itself (BR-018-18). */
  readonly title?: string;
  readonly className?: string;
}

export function StateBadge({ state, label, title, className }: StateBadgeProps): React.JSX.Element {
  return (
    <Badge
      data-slot="state-badge"
      data-state={state}
      title={title}
      className={cn(STATE_CLASSES[state], className)}
    >
      {label}
    </Badge>
  );
}
