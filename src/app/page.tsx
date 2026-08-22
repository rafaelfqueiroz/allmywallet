import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { MarketingShell } from '@/components/marketing/marketing-shell';
import { Hero } from '@/components/marketing/hero';
import { FeatureGrid } from '@/components/marketing/feature-grid';
import { TrustPoints } from '@/components/marketing/trust-points';
import { CallToAction } from '@/components/marketing/call-to-action';

/**
 * #37 — the public surface. The first thing an unauthenticated visitor sees,
 * and the only screen in the product written for someone who has not decided
 * to use it yet.
 *
 * **Statically prerendered, and that is the requirement, not an optimisation.**
 * Nothing here reads the session, the cookies or the database: this is the one
 * page whose job is to be fast and indexable, and a single cookie read opts it
 * into rendering on demand for every visitor (DS-40 — the same mistake the
 * root layout already made once). A signed-in visitor is therefore redirected
 * *before* the page runs, by `src/middleware.ts`, which is why that file exists
 * at all (#37 decision log).
 *
 * The sections live in `src/components/marketing/`. They consume the design
 * system and extend nothing: no colour, no spacing and no string literal
 * appears in this file, which is what DS-22 and AR-44 enforce mechanically.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('marketing.meta');

  const title = t('title');
  const description = t('description');

  return {
    title,
    description,
    /*
     * Deliberately no `openGraph.url`, no `openGraph.images` and no canonical:
     * all three resolve against `metadataBase`, and the product has no domain
     * yet — the deploy takes it from `DOMAIN` at runtime, which a prerendered
     * page cannot see. Setting them anyway would bake `http://localhost:3000`
     * into every share card. The tags that need no origin are here now; the
     * image and the canonical are a one-line follow-up the day the domain
     * exists.
     */
    openGraph: {
      type: 'website',
      locale: 'pt_BR',
      siteName: 'AllMyWallet',
      title,
      description,
    },
    twitter: { card: 'summary', title, description },
  };
}

export default function HomePage() {
  return (
    <MarketingShell>
      <Hero />
      <FeatureGrid />
      <TrustPoints />
      <CallToAction />
    </MarketingShell>
  );
}
