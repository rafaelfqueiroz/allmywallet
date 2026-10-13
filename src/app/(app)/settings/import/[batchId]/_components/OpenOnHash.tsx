'use client';

import { useEffect, useState, type ReactNode } from 'react';

/**
 * SPEC-022 BR-022-18 (#211, #237) — Ignoradas is a disclosure, closed until
 * somebody wants the mirrors. Paging inside it navigates (DS-66), and a link
 * that lands on a closed disclosure would look like it did nothing, so it
 * opens when the page was asked for one of its table's parameters
 * (`openByDefault`, decided by the server) or when the URL's fragment names it.
 *
 * State, not the server's flag on every render: going back to page 1 drops
 * the table's parameters (a default is never written), and a disclosure bound
 * to their presence would close under the reader. Once open it stays as the
 * reader left it; the fragment only ever opens it.
 */
export function OpenOnHash({
  id,
  openByDefault,
  summary,
  children,
}: {
  /** The fragment (without `#`) that opens the disclosure. */
  readonly id: string;
  readonly openByDefault: boolean;
  readonly summary: ReactNode;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(openByDefault);

  useEffect(() => {
    const follow = () => {
      if (window.location.hash === `#${id}`) setOpen(true);
    };
    follow();
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, [id]);

  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm">{summary}</summary>
      {children}
    </details>
  );
}
