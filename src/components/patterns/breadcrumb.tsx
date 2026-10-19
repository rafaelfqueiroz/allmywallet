import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * SPEC-022 BR-022-09 (amended, DL-022-27) — a breadcrumb, as the frames draw
 * it at the start of the top bar: small, muted, "›" between levels.
 *
 * A named `<nav>` holding an ordered list, as the WAI-ARIA breadcrumb pattern
 * has it. Every earlier crumb is a link to its level, even where that level
 * opens on this very page (“Portfólio” on Patrimônio, “Carteiras” on Minhas
 * carteiras): the crumb names the level, not the page. The last is the current
 * page — plain text with `aria-current="page"` (DS-27). The separators are
 * decoration and hidden from assistive technology, which announces the list.
 *
 * **Every crumb truncates, none overflows** (#261 review). At `md` with the
 * sidebar expanded and a long account name the bar leaves the trail ~180 px,
 * and a crumb that cannot shrink overflows its item and is drawn over the
 * next. Each label is `min-w-0 truncate` within its item and carries its full
 * text as a `title`; the accessible name is the full text either way.
 *
 * Knows nothing about routes (DS-02): `AppShell` resolves the path to crumbs
 * (`breadcrumbs.ts`) and passes them translated.
 */
export type BreadcrumbItem = {
  readonly href: string;
  /** Translated text — AR-44. */
  readonly label: string;
};

export function Breadcrumb({
  label,
  items,
  className,
}: {
  /** The `<nav>`'s accessible name, distinguishing it from the menu's. */
  readonly label: string;
  readonly items: readonly BreadcrumbItem[];
  readonly className?: string;
}) {
  if (items.length === 0) return null;

  return (
    <nav aria-label={label} data-slot="breadcrumb" className={cn('min-w-0', className)}>
      <ol className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            // The label, not the href: a destination and its first tab share
            // one (`/portfolio` is Patrimônio), but never one name.
            <li key={item.label} className="flex min-w-0 items-center gap-1">
              {index > 0 && <ChevronRight aria-hidden className="size-3.5 shrink-0" />}
              {last ? (
                <span aria-current="page" title={item.label} className="min-w-0 truncate">
                  {item.label}
                </span>
              ) : (
                <Link
                  href={item.href}
                  title={item.label}
                  className="min-w-0 truncate rounded-sm outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {item.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
