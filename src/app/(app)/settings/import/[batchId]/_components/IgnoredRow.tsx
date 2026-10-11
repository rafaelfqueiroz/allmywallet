import type { ReactNode } from 'react';
import type { ImportRow } from '@/core/ingestion/ports';
import { isResolvedSubscriptionExercise } from '@/core/ingestion/resolved-subscription-exercise';
import { RowCells } from '@/app/(app)/settings/import/[batchId]/_components/RowCells';
import { TableCell, TableRow } from '@/components/ui/table';
import { Text } from '@/components/ui/text';

interface IgnoredRowProps {
  readonly row: ImportRow;
  readonly committed: boolean;
  readonly resolvedExerciseLabel: string;
  readonly classifyForm: (rowId: string) => ReactNode;
}

/**
 * SPEC-005 BR-005-19/20d (#179): a consumed exercise remains visible without a
 * classify action. One row of the Ignoradas table (SPEC-022 BR-022-18, #211).
 */
export function IgnoredRow({
  row,
  committed,
  resolvedExerciseLabel,
  classifyForm,
}: IgnoredRowProps) {
  return (
    <TableRow>
      <RowCells row={row} />
      <TableCell className="py-row align-top whitespace-normal">
        {isResolvedSubscriptionExercise(row) ? (
          <Text as="span" size="xs" tone="muted">
            {resolvedExerciseLabel}
          </Text>
        ) : (
          committed && classifyForm(row.id)
        )}
      </TableCell>
    </TableRow>
  );
}
