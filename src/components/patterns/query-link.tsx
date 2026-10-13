'use client';

import type { ComponentProps } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

/**
 * SPEC-022 BR-022-18 — a link that changes one query parameter and keeps the
 * rest of the URL.
 *
 * A row's "Editar" or "Resolver" opens a form **outside** the table (no form
 * sits in a cell — DS-28), by naming the row in the URL. The tables on the page
 * keep their own sort, page and filter in that same URL, so a link built on the
 * server from the request's parameters would drop the state the reader has just
 * set — a click on a row of page 3 would put the table back on page 1 under
 * them. Built here, from the live parameters, it does not.
 *
 * It renders on the server too (`useSearchParams` reads the request), so the
 * link works before hydration and without JavaScript.
 */
export function QueryLink({
  set,
  drop,
  hash,
  ...props
}: Omit<ComponentProps<typeof Link>, 'href'> & {
  /** Parameters to set. */
  readonly set?: Readonly<Record<string, string>>;
  /** Parameters to remove. */
  readonly drop?: readonly string[];
  /** The fragment to land on, without `#`. */
  readonly hash?: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const next = new URLSearchParams(searchParams.toString());
  for (const name of drop ?? []) next.delete(name);
  for (const [name, value] of Object.entries(set ?? {})) next.set(name, value);
  const query = next.toString();
  const href = `${pathname}${query === '' ? '' : `?${query}`}${hash === undefined ? '' : `#${hash}`}`;

  return <Link href={href} {...props} />;
}
