import { useTranslations } from 'next-intl';
import type { PositionState } from '@/core/positions/position-state';
import { Section } from '@/components/patterns/section';
import { Money } from '@/app/money';
import { CostEstimateMarker } from '@/components/patterns/cost-estimate-marker';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Text } from '@/components/ui/text';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * SPEC-006 BR-006-13 (#144 re-review N3) — "a confirmation stating what will
 * be recalculated". Since SPEC-007 BR-007-06 (#144 F6) a delete also re-derives
 * the cost this position carried on to others — a transfer's credit, an
 * import conversion's target — and recalculates them. Each is stated here,
 * before and after, the same three figures and marker as the row's own
 * position, so none of them changes silently.
 *
 * Renders nothing when the delete reaches no other position. Rendered by the
 * delete page on the server: the figures are the core's `Money`/`Quantity`
 * values and never cross a client boundary (AR-10).
 */
export interface DownstreamImpactRow {
  /** Stable React key — the position's `(asset, institution)`. */
  readonly key: string;
  readonly assetLabel: string;
  readonly institutionLabel: string | null;
  readonly currentPosition: PositionState;
  readonly projectedPosition: PositionState;
  readonly currentCostEstimated: boolean;
  readonly projectedCostEstimated: boolean;
}

export interface DeletionDownstreamImpactProps {
  readonly rows: readonly DownstreamImpactRow[];
}

export function DeletionDownstreamImpact({ rows }: DeletionDownstreamImpactProps) {
  const t = useTranslations('transactions.delete');
  const tTable = useTranslations('transactions.table');
  // Same catalogue entry every Custo/preço médio surface reads (DL-007-12).
  const tReports = useTranslations('reports');
  const tCommon = useTranslations('common');
  if (rows.length === 0) return null;

  const marker = (shown: boolean) => (
    <CostEstimateMarker
      shown={shown}
      label={tCommon('estimated')}
      title={tReports('markers.costEstimated.explanation')}
    />
  );

  return (
    <Section title={t('downstreamTitle')}>
      <Stack gap="md">
        <Text>{t('downstreamDescription')}</Text>
        {rows.map((row) => {
          const label =
            row.institutionLabel === null
              ? t('downstreamPositionNoInstitution', { asset: row.assetLabel })
              : t('downstreamPosition', {
                  asset: row.assetLabel,
                  institution: row.institutionLabel,
                });
          return (
            <Table key={row.key}>
              <TableCaption className="sr-only">{label}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{label}</TableHead>
                  <TableHead scope="col" className="text-right">
                    {t('impactCurrent')}
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    {t('impactProjected')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell className="py-row">{t('impactQuantity')}</TableCell>
                  <TableCell className="py-row text-right">
                    <Money value={row.currentPosition.quantity} kind="quantity" />
                  </TableCell>
                  <TableCell className="py-row text-right">
                    <Money value={row.projectedPosition.quantity} kind="quantity" />
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="py-row">{t('impactAverageCost')}</TableCell>
                  <TableCell className="py-row text-right">
                    <Cluster gap="sm" justify="end" align="baseline">
                      <Money value={row.currentPosition.averageCost} />
                      {marker(row.currentCostEstimated)}
                    </Cluster>
                  </TableCell>
                  <TableCell className="py-row text-right">
                    <Cluster gap="sm" justify="end" align="baseline">
                      <Money value={row.projectedPosition.averageCost} />
                      {marker(row.projectedCostEstimated)}
                    </Cluster>
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="py-row">{tTable('total')}</TableCell>
                  <TableCell className="py-row text-right">
                    <Money value={row.currentPosition.totalCost} />
                  </TableCell>
                  <TableCell className="py-row text-right">
                    <Money value={row.projectedPosition.totalCost} />
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          );
        })}
      </Stack>
    </Section>
  );
}
