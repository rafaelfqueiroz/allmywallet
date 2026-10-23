import type { ReactNode } from 'react';
import type { ImportRow } from '@/core/ingestion/ports';
import { isResolvedSubscriptionExercise } from '@/core/ingestion/resolved-subscription-exercise';
import { rowIdentityCells } from '@/app/(app)/settings/import/[batchId]/_components/RowCells';
import type { NodeRow } from '@/components/patterns/node-table';
import { Text } from '@/components/ui/text';

interface IgnoredRowProps {
  readonly row: ImportRow;
  readonly committed: boolean;
  readonly resolvedExerciseLabel: string;
  /** SPEC-005 BR-005-20f (#215): introduces the reason a user gave. */
  readonly reasonLabel: string;
  readonly classifyForm: (rowId: string) => ReactNode;
}

/**
 * SPEC-005 BR-005-19/20d (#179): a consumed exercise remains visible without a
 * classify action. BR-005-20f (#215): a row the user ignored shows its reason. One row of the Ignoradas table (SPEC-022 BR-022-18, #211),
 * as the cells of a `NodeTable` row. The classify form is in the cell, once:
 * the table renders without a card copy (`cards={false}`), so it is not doubled.
 */
export function ignoredRow({
  row,
  committed,
  resolvedExerciseLabel,
  reasonLabel,
  classifyForm,
}: IgnoredRowProps): NodeRow {
  return {
    id: row.id,
    cells: {
      ...rowIdentityCells(row),
      // SPEC-005 BR-005-20f (#215): a row the user ignored keeps the reason they
      // gave, which is what keeps the decision auditable (DL-005-31).
      detail: row.ignoredReason ? (
        <Text as="span" size="xs" className="whitespace-normal">
          {reasonLabel} {row.ignoredReason}
        </Text>
      ) : null,
      action: isResolvedSubscriptionExercise(row) ? (
        <Text as="span" size="xs" tone="muted">
          {resolvedExerciseLabel}
        </Text>
      ) : (
        committed && classifyForm(row.id)
      ),
    },
  };
}
