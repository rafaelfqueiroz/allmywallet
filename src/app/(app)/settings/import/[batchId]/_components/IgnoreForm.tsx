import { IGNORE_REASON_MAX_LENGTH } from '@/core/ingestion/ignore-row';
import type { ActionState } from '@/lib/action-state';
import { ActionForm } from '@/components/patterns/action-form';
import { Field, FieldAction } from '@/components/patterns/field';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * SPEC-005 BR-005-20f (#215) — **Ignorar, com motivo**, beside the classify
 * form on an `unclassified` row of a committed batch.
 *
 * The reason is required here and refused blank by `ignoreImportRow` too — a
 * stale or direct submission must not reach the use case unchecked — and the
 * hint says the step is reversible, because a user who believes it is final
 * will not take it for a row they are only fairly sure about. Not drawn as
 * destructive: nothing is deleted and BR-005-20 brings the row back.
 */
export interface IgnoreFormLabels {
  readonly reason: string;
  readonly reasonHint: string;
  readonly submit: string;
}

export function IgnoreForm({
  rowId,
  action,
  labels,
}: {
  readonly rowId: string;
  readonly action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  readonly labels: IgnoreFormLabels;
}) {
  return (
    <ActionForm action={action}>
      <input type="hidden" name="rowId" value={rowId} />
      {/* Fields align from the top, the button through `FieldAction`, so the
          row has one height (SPEC-022 BR-022-20). */}
      <Cluster gap="sm" align="start">
        <Field
          id={`ignore-reason-${rowId}`}
          label={labels.reason}
          hint={labels.reasonHint}
          width="lg"
        >
          <Input name="reason" required maxLength={IGNORE_REASON_MAX_LENGTH} autoComplete="off" />
        </Field>
        <FieldAction>
          <Button type="submit" size="sm" variant="outline">
            {labels.submit}
          </Button>
        </FieldAction>
      </Cluster>
    </ActionForm>
  );
}
