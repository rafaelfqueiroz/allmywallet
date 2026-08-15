import type * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { Cluster } from '@/components/layout/cluster';
import { Stack } from '@/components/layout/stack';

/**
 * The one place a page decides how wide it is. Before this existed the five
 * screens on `main` used five different max-widths — `max-w-2xl`, `3xl`, `4xl`,
 * `5xl` and `md` — on screens that are peers, which is the drift #33 was
 * opened to stop. Three named widths, chosen deliberately, is the replacement.
 */
const pageShellVariants = cva('mx-auto w-full px-4 py-6 sm:px-6 sm:py-10', {
  variants: {
    width: {
      /** Forms and settings — long measure hurts readability. */
      narrow: 'max-w-2xl',
      /** The default for list and detail screens. */
      default: 'max-w-5xl',
      /** Reports: wide tables and charts need the room. */
      wide: 'max-w-7xl',
    },
  },
  defaultVariants: { width: 'default' },
});

export type PageShellProps = React.ComponentProps<'main'> &
  VariantProps<typeof pageShellVariants> & {
    /** Rendered as the page's <h1>. Pass translated text — AR-44. */
    title?: React.ReactNode;
    description?: React.ReactNode;
    /** Buttons or filters aligned with the title on wide screens. */
    actions?: React.ReactNode;
  };

export function PageShell({
  className,
  width,
  title,
  description,
  actions,
  children,
  ...props
}: PageShellProps) {
  return (
    <main data-slot="page-shell" className={cn(pageShellVariants({ width }), className)} {...props}>
      <Stack gap="lg">
        {(title || description || actions) && (
          <Cluster justify="between" align="start" gap="md">
            <Stack gap="xs">
              {title && <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>}
              {description && <p className="text-muted-foreground">{description}</p>}
            </Stack>
            {actions && <Cluster gap="sm">{actions}</Cluster>}
          </Cluster>
        )}
        {children}
      </Stack>
    </main>
  );
}

export { pageShellVariants };
