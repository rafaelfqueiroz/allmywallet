import type { ReactNode } from 'react';

/**
 * SPEC-022 BR-022-18 — a table's pinned totals as they read below `md`, where
 * the table is rows under hairlines and has no columns: the total's name, then
 * each figure under its column's own label. It is `DataTable`'s `footer.card`.
 *
 * A `dl` of label/value pairs, each pair in one wrapping `div` — the structure
 * the cards use for a row (see `DataTable`), so the term/definition association
 * survives for a screen reader.
 */
export function TotalsCard({
  label,
  figures,
}: {
  readonly label: ReactNode;
  readonly figures: readonly { readonly label: string; readonly value: ReactNode }[];
}) {
  return (
    <div className="flex flex-col gap-1">
      <p>{label}</p>
      <dl className="flex flex-col gap-1">
        {figures.map((figure) => (
          <div
            key={figure.label}
            className="flex flex-wrap items-baseline justify-between gap-2 font-normal"
          >
            <dt className="text-xs text-muted-foreground">{figure.label}</dt>
            <dd className="text-sm">{figure.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
