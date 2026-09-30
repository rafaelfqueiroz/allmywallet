import type { ReactNode } from 'react';
import type { ImportRow } from '@/core/ingestion/ports';
import { isResolvedSubscriptionExercise } from '@/core/ingestion/resolved-subscription-exercise';
import { formatBusinessDate } from '@/i18n/format';
import { ListItem } from '@/components/layout/list';
import { Stack } from '@/components/layout/stack';
import { Text } from '@/components/ui/text';

interface IgnoredRowProps {
  readonly row: ImportRow;
  readonly committed: boolean;
  readonly resolvedExerciseLabel: string;
  readonly classifyForm: (rowId: string) => ReactNode;
}

/** SPEC-005 BR-005-19/20d (#179): a consumed exercise remains visible without a classify action. */
export function IgnoredRow({
  row,
  committed,
  resolvedExerciseLabel,
  classifyForm,
}: IgnoredRowProps) {
  return (
    <ListItem separated>
      <Stack gap="sm" align="start">
        <span className="font-medium">{row.record.assetCode}</span>
        <Text as="span" size="xs" tone="muted">
          {row.record.kind === 'transaction'
            ? `${row.record.b3Type} · ${formatBusinessDate(row.record.tradeDate)}`
            : ''}
        </Text>
        {isResolvedSubscriptionExercise(row) ? (
          <Text as="span" size="xs" tone="muted">
            {resolvedExerciseLabel}
          </Text>
        ) : (
          committed && classifyForm(row.id)
        )}
      </Stack>
    </ListItem>
  );
}
