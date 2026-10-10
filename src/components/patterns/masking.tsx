'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * SPEC-022 BR-022-24/25 — the masking state the **frame** shows: the eye
 * toggle's pressed state.
 *
 * The frame is a layout, and Next does not re-render a layout on a client-side
 * navigation. So the value the layout read can go stale: masking turned on in
 * another tab, or on another device, and this tab navigates to a page the
 * server renders masked under an eye that still reads "not pressed". Every
 * signed-in page therefore reports the value *it* was rendered with through
 * `MaskingSync` (rendered by `PageShell` from `@/app/page-shell`), and the
 * frame follows the page.
 *
 * Nothing that hides an amount reads this. Amounts are masked by the server
 * (`@/app/money`), and charts take `masked` as a prop from the same render
 * that rescaled their coordinates — so a stale frame can only ever mislabel
 * the toggle for one commit, never show or hide a figure.
 */
interface Masking {
  readonly masked: boolean;
  readonly report: (masked: boolean) => void;
}

const MaskingContext = createContext<Masking>({ masked: false, report: () => {} });

export function MaskingProvider({
  masked: initial,
  children,
}: {
  /** What the layout read, until a page reports what it read. */
  readonly masked: boolean;
  readonly children: ReactNode;
}) {
  const [state, setState] = useState({ seed: initial, masked: initial });
  // A fresh layout render with a different value (the toggle's own
  // revalidation) is newer than any page report before it. Adjusted during
  // render rather than in an effect: a parent's effect runs after its
  // children's, so an effect here would overwrite the page's report on mount.
  if (state.seed !== initial) setState({ seed: initial, masked: initial });
  const report = useCallback(
    (masked: boolean) => setState((current) => ({ ...current, masked })),
    [],
  );
  return (
    <MaskingContext.Provider value={{ masked: state.masked, report }}>
      {children}
    </MaskingContext.Provider>
  );
}

/** Whether the frame should show amounts as hidden. `false` outside a provider. */
export function useMasked(): boolean {
  return useContext(MaskingContext).masked;
}

/** A page's report of the masking it was rendered with. Renders nothing. */
export function MaskingSync({ masked }: { readonly masked: boolean }) {
  const { report } = useContext(MaskingContext);
  useEffect(() => report(masked), [masked, report]);
  return null;
}
