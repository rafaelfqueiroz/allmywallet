'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * SPEC-022 BR-022-24/25 — the masking state, for Client Components.
 *
 * Server Components never read this: they render `Money` from `@/app/money`,
 * which asks the server directly. A chart cannot, because it renders its labels
 * in the browser, so the frame passes the value the server read down to it
 * through this provider. The value arrives as a prop from the server render,
 * so the first client render is already masked — nothing is painted and then
 * hidden.
 */
const MaskingContext = createContext(false);

export function MaskingProvider({
  masked,
  children,
}: {
  readonly masked: boolean;
  readonly children: ReactNode;
}) {
  return <MaskingContext.Provider value={masked}>{children}</MaskingContext.Provider>;
}

/** Whether money amounts are hidden. `false` outside a provider. */
export function useMasked(): boolean {
  return useContext(MaskingContext);
}
