import { normalizeMovementType } from '@/core/ingestion/movement-map';
import type { ImportRow } from '@/core/ingestion/ports';

/**
 * SPEC-005 BR-005-19/20/20d (#179): an ignored exercise has already been
 * consumed by the credit on the main asset. The row stays visible, but cannot
 * be classified as another transaction without counting the shares twice.
 */
export function isResolvedSubscriptionExercise(row: ImportRow): boolean {
  return (
    row.classification === 'ignored' &&
    row.record.kind === 'transaction' &&
    normalizeMovementType(row.record.b3Type) === 'direitos de subscricao - exercido'
  );
}
