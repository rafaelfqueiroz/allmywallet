import type { ActionState } from '@/lib/action-state';
import type { OpportunityState } from '@/core/opportunity/ports';
import { ActionForm } from '@/components/patterns/action-form';
import { Field } from '@/components/patterns/field';
import { Cluster } from '@/components/layout/cluster';
import { Stack } from '@/components/layout/stack';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/**
 * SPEC-018 BR-018-05..10 — the one form shared by "create a rule" and "edit a
 * rule", identical to how `wallets/[walletId]/goals/_components/GoalEditDeleteForms.tsx`
 * reuses one shape for both. A Server Component: the only client-side
 * behaviour a plain `<form action={serverAction}>` needs is none — the
 * submit posts, the action validates and calls `createRule`/`updateRule`
 * (AR-31/AR-32), and `ActionForm` renders whatever it refuses.
 *
 * BR-018-06/DL-018-02 — every state select offers the same three options and
 * carries no default reading of what a bound "should" mean: the placeholder
 * option is blank, not pre-selected to any particular state, so a bound with
 * a price but no chosen state is a shape this form makes as easy to leave
 * incomplete as to fill in, and the server refuses it either way
 * (`NO_BOUNDS_SET`/`INVALID_THRESHOLD` in `core/opportunity/rule.ts`).
 */

export interface RuleFormLabels {
  readonly hint: string;
  readonly lowerPriceLabel: string;
  readonly lowerStateLabel: string;
  readonly upperPriceLabel: string;
  readonly upperStateLabel: string;
  readonly defaultStateLabel: string;
  readonly submit: string;
  /** BR-018-17/DL-018-06 — the same three-word labels the `StateBadge`s on this page use. */
  readonly stateOptions: Readonly<Record<OpportunityState, string>>;
}

export interface RuleFormInitial {
  readonly lowerPrice?: string | undefined;
  readonly lowerState?: OpportunityState | undefined;
  readonly upperPrice?: string | undefined;
  readonly upperState?: OpportunityState | undefined;
  readonly defaultState?: OpportunityState | undefined;
}

const STATE_ORDER: readonly OpportunityState[] = ['buy', 'hold', 'sell'];

export function RuleForm({
  action,
  assetId,
  idPrefix,
  labels,
  initial,
}: {
  readonly action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  readonly assetId: string;
  /** Unique per rendered form on the page — two rules on screen must not collide on field ids. */
  readonly idPrefix: string;
  readonly labels: RuleFormLabels;
  readonly initial?: RuleFormInitial;
}) {
  const stateOptions = STATE_ORDER.map((value) => (
    <option key={value} value={value}>
      {labels.stateOptions[value]}
    </option>
  ));

  return (
    <ActionForm action={action}>
      <input type="hidden" name="assetId" value={assetId} />
      <Stack gap="md">
        <Text as="span" size="xs" tone="muted">
          {labels.hint}
        </Text>

        <Cluster gap="md" align="end">
          <Field id={`${idPrefix}-lower-price`} label={labels.lowerPriceLabel} width="sm">
            <Input name="lowerPrice" inputMode="decimal" defaultValue={initial?.lowerPrice} />
          </Field>
          <Field id={`${idPrefix}-lower-state`} label={labels.lowerStateLabel} width="md">
            <NativeSelect name="lowerState" defaultValue={initial?.lowerState ?? ''}>
              <option value="">—</option>
              {stateOptions}
            </NativeSelect>
          </Field>
        </Cluster>

        <Cluster gap="md" align="end">
          <Field id={`${idPrefix}-upper-price`} label={labels.upperPriceLabel} width="sm">
            <Input name="upperPrice" inputMode="decimal" defaultValue={initial?.upperPrice} />
          </Field>
          <Field id={`${idPrefix}-upper-state`} label={labels.upperStateLabel} width="md">
            <NativeSelect name="upperState" defaultValue={initial?.upperState ?? ''}>
              <option value="">—</option>
              {stateOptions}
            </NativeSelect>
          </Field>
        </Cluster>

        <Field id={`${idPrefix}-default-state`} label={labels.defaultStateLabel} width="md">
          <NativeSelect name="defaultState" defaultValue={initial?.defaultState ?? 'hold'} required>
            {stateOptions}
          </NativeSelect>
        </Field>

        <Cluster>
          <Button type="submit">{labels.submit}</Button>
        </Cluster>
      </Stack>
    </ActionForm>
  );
}
