import type * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';

/**
 * The frame for the public surface at `/` — header, content column, footer.
 *
 * A third frame alongside `PageShell` and `AuthShell` rather than a variant of
 * either, because the shapes do not overlap: `PageShell` is a document inside
 * the application's navigation, `AuthShell` is a viewport-centred card with no
 * navigation at all, and this is a full-height marketing page with its own
 * header and footer and no session.
 *
 * It lives in `src/components/marketing/` and not in `patterns/` on purpose
 * (#37): nothing else in the product will ever render it, and a pattern that
 * has exactly one caller is a page in the wrong directory.
 */
export type MarketingShellProps = React.ComponentProps<'div'>;

export function MarketingShell({ children, className, ...props }: MarketingShellProps) {
  const t = useTranslations('marketing');
  const app = useTranslations('app');

  return (
    <div
      data-slot="marketing-shell"
      className={cn('mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-6 py-6', className)}
      {...props}
    >
      <header>
        <Cluster justify="between" gap="md">
          {/* The brand is not a link: `/` is the page this header is on, and a
              link to the current page is noise for a screen reader. */}
          <span className="text-base font-semibold tracking-tight">{app('name')}</span>
          <nav aria-label={t('header.label')}>
            <Button asChild variant="ghost" size="sm">
              <Link href="/signin">{t('header.signIn')}</Link>
            </Button>
          </nav>
        </Cluster>
      </header>

      <main className="flex-1">
        <Stack gap="xl">{children}</Stack>
      </main>

      <footer className="mt-16 border-t pt-6">
        <Cluster justify="between" gap="md">
          <span className="text-xs text-muted-foreground">{app('tagline')}</span>
          <Cluster gap="md">
            {/* SPEC-004 BR-004-15: the policy is public, and this is the page
                a prospective user reads before deciding to create an account.
                Reaching it must not require signing in first. */}
            <Link href="/privacy-policy" className="text-xs underline">
              {t('footer.privacyPolicy')}
            </Link>
            <Link href="/signin" className="text-xs underline">
              {t('footer.signIn')}
            </Link>
          </Cluster>
        </Cluster>
      </footer>
    </div>
  );
}
