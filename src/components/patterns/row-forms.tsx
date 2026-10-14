import type { ReactNode } from 'react';

/**
 * SPEC-022 BR-022-18 — where the forms a table's row controls name through
 * their `form` attribute live: **outside** the table.
 *
 * `DataTable` renders every cell twice (DS-28), so a form in a cell would post
 * its fields twice and repeat its ids. A row control is instead a `<button
 * form="…">` in the cell — or a `RowMenuSubmit` item of the row's "⋯" menu,
 * which submits the form by id — and the form it submits is here: one small
 * form per row, each holding only hidden fields.
 *
 * They take no room: a form with only hidden inputs has no height, and this
 * host adds none (so the pager the table ends in still closes the panel). Only
 * a refusal makes it visible — an `ErrorState` from the action — and then it
 * clears the pager above it.
 *
 * Place it **after** the table, as its last sibling in the panel.
 */
export function RowForms({ children }: { readonly children: ReactNode }) {
  return (
    <div data-slot="row-forms" className="pt-0 has-[[data-slot=error-state]]:pt-4">
      {children}
    </div>
  );
}
