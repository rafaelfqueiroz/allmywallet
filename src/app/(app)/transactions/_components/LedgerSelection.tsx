'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { BULK_FORM_ID } from '@/app/(app)/transactions/_components/BulkBar';

/**
 * SPEC-006 BR-006-17 — one selection for the ledger's two renderings.
 *
 * `DataTable` renders every row twice, as a table row and as a card, and CSS
 * shows one (DS-28). Two independent checkboxes per row could disagree: tick A
 * on a wide screen, narrow the window, tick B, and the card shows A unticked
 * while A's hidden table checkbox — still ticked — posts with B, so a bulk
 * delete removes a row the reader can see is not selected (PR #234 review P1).
 *
 * So both copies of a row's checkbox read and write one set of ids held here.
 * What is on screen is what posts: a checkbox shows ticked exactly when its
 * transaction is selected, whichever rendering is visible, and both copies
 * then post the same id, which the bulk action reads once.
 *
 * Without JavaScript the boxes are plain native checkboxes, as before; the
 * disagreement needs a resize between two ticks, and the action still reads a
 * repeated id once.
 */
const SelectionContext = createContext<{
  readonly selected: ReadonlySet<string>;
  readonly toggle: (id: string, checked: boolean) => void;
} | null>(null);

/**
 * The selection's owner. `LedgerTable` keys it on the page's rows, so a sort,
 * a page or a filter starts from an empty selection rather than carrying ticks
 * the reader can no longer see.
 */
export function LedgerSelection({ children }: { readonly children: ReactNode }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  /*
   * React resets the bulk form once its action has run, and the reset unticks
   * every box the form owns in the DOM — but these are controlled, so state
   * would still say "selected" behind an empty box. The reset is the moment a
   * bulk operation finished; the selection empties with it.
   */
  useEffect(() => {
    const form = document.getElementById(BULK_FORM_ID);
    const clear = () => setSelected(new Set());
    form?.addEventListener('reset', clear);
    return () => form?.removeEventListener('reset', clear);
  }, []);
  const toggle = (id: string, checked: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  return (
    <SelectionContext.Provider value={{ selected, toggle }}>{children}</SelectionContext.Provider>
  );
}

/** A row's checkbox, in either rendering. Posts with the bulk form via `form`. */
export function RowSelect({ id, label }: { readonly id: string; readonly label: string }) {
  const selection = useContext(SelectionContext);
  return (
    <Checkbox
      form={BULK_FORM_ID}
      name="selected"
      value={id}
      aria-label={label}
      {...(selection
        ? {
            checked: selection.selected.has(id),
            onChange: (event) => selection.toggle(id, event.target.checked),
          }
        : {})}
    />
  );
}
