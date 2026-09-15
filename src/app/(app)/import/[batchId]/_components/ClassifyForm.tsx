import { TRANSACTION_TYPES, type TransactionType } from '@/core/ledger/transaction';
import type { ActionState } from '@/lib/action-state';
import { ActionForm } from '@/components/patterns/action-form';
import { Field } from '@/components/patterns/field';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';

/**
 * SPEC-005 BR-005-20 / SPEC-007 BR-007-04a (#113) — classifying an
 * `unclassified` row, with the ratio `split`/`grupamento` need.
 *
 * Extracted from `page.tsx` (AR-04: `app/` stays thin) so this form's own
 * behaviour — every `TransactionType` offered, the ratio field present, a
 * refusal shown rather than swallowed — has a test independent of the
 * batch page's DB-backed data loading. `ActionForm` (already covered by its
 * own test) is what turns `classifyRowAction`'s `ActionState` into the
 * `errors.*` message on screen (BR-006-15) — this component supplies nothing
 * beyond the fields and the labels.
 *
 * **The ratio field is always rendered, not revealed for `split`/`grupamento`
 * only.** This form has no client script toggling visibility by the selected
 * type — the same choice `transactions/_components/TransactionForm.tsx` made
 * for its own ratio field — so the hint is what says when the field applies,
 * and the form degrades correctly with no JavaScript at all.
 */
export interface ClassifyFormLabels {
  readonly type: string;
  readonly ratio: string;
  readonly ratioHint: string;
  readonly submit: string;
  readonly typeName: (type: TransactionType) => string;
}

export function ClassifyForm({
  rowId,
  action,
  labels,
}: {
  readonly rowId: string;
  readonly action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  readonly labels: ClassifyFormLabels;
}) {
  return (
    <ActionForm action={action}>
      <input type="hidden" name="rowId" value={rowId} />
      <Cluster gap="sm" align="end">
        <Field id={`classify-${rowId}`} label={labels.type} width="lg">
          <NativeSelect name="type" required>
            {TRANSACTION_TYPES.map((type) => (
              <option key={type} value={type}>
                {labels.typeName(type)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          id={`classify-ratio-${rowId}`}
          label={labels.ratio}
          hint={labels.ratioHint}
          width="sm"
        >
          <Input name="ratio" inputMode="decimal" />
        </Field>
        <Button type="submit" size="sm">
          {labels.submit}
        </Button>
      </Cluster>
    </ActionForm>
  );
}
