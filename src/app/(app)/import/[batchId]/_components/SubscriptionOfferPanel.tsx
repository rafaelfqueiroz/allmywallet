import type { ReactNode } from 'react';
import type { ActionState } from '@/lib/action-state';
import { ActionForm } from '@/components/patterns/action-form';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Text } from '@/components/ui/text';

/**
 * SPEC-005 BR-005-20d (#157, DL-005-25) — the two actions offered for a
 * `needsAttention` exercise row whose credit is a hand-classified,
 * **zero-cost** credit (#157's HGLG12/MGFF12/VISC13). Rendered *instead of*
 * `ClassifyForm` for such a row (#157 description, problem 1): classifying
 * the exercise as any type would count the shares it moved a second time,
 * on top of what the credit already added.
 *
 * All strings arrive pre-translated (AR-44), exactly as `ClassifyForm` takes
 * `labels` — this stays a plain, synchronous component with no `next-intl`
 * server machinery in its test, and every value already formatted through
 * `@/i18n/format` (AR-09/AR-47) by the caller, never `toLocaleString` here.
 */
export interface SubscriptionOfferLabels {
  /** The pairing sentence — quantity, credit asset, date, and how the user classified it. */
  readonly pairing: string;
  /** Present only with a stored close (DL-005-22 D1): what resolving will price it at. */
  /**
   * A sentence, and an element rather than a string: masked, its price is a
   * `MoneyMask` carrying its own accessible name (SPEC-022 BR-022-26).
   */
  readonly priceHint: ReactNode | null;
  /** Present only without a stored close: why "Resolver como subscrição" is disabled. */
  readonly closeMissingReason: string | null;
  readonly estimateBadge: string;
  readonly resolve: string;
  readonly keep: string;
}

export function SubscriptionOfferPanel({
  rowId,
  resolveAction,
  keepAction,
  labels,
}: {
  readonly rowId: string;
  readonly resolveAction: (state: ActionState, formData: FormData) => Promise<ActionState>;
  readonly keepAction: (state: ActionState, formData: FormData) => Promise<ActionState>;
  readonly labels: SubscriptionOfferLabels;
}) {
  // D1 (#144): no stored close, no invented price — "Resolver como
  // subscrição" refuses rather than guess one, so the button is disabled
  // here too, with the same reason visible rather than only in a tooltip.
  const hasClose = labels.priceHint !== null;

  return (
    <Stack gap="sm" align="start">
      <Text as="span" size="xs">
        {labels.pairing}
      </Text>
      {hasClose ? (
        <Cluster gap="sm" align="baseline">
          <Text as="span" size="xs">
            {labels.priceHint}
          </Text>
          <Badge variant="outline">{labels.estimateBadge}</Badge>
        </Cluster>
      ) : (
        <Text as="span" size="xs" tone="muted">
          {labels.closeMissingReason}
        </Text>
      )}
      <Cluster gap="sm">
        <ActionForm action={resolveAction}>
          <input type="hidden" name="rowId" value={rowId} />
          <Button
            type="submit"
            size="sm"
            disabled={!hasClose}
            title={hasClose ? undefined : (labels.closeMissingReason ?? undefined)}
          >
            {labels.resolve}
          </Button>
        </ActionForm>
        <ActionForm action={keepAction}>
          <input type="hidden" name="rowId" value={rowId} />
          <Button type="submit" size="sm" variant="outline">
            {labels.keep}
          </Button>
        </ActionForm>
      </Cluster>
    </Stack>
  );
}
