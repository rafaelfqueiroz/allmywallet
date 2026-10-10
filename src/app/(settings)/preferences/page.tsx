import { getTranslations } from 'next-intl/server';
import { tryUserId } from '@/lib/session';
import { ParameterForm } from '@/app/parameter-form';
import { PageShell } from '@/app/page-shell';
import { EmptyState } from '@/components/patterns/empty-state';

/**
 * SPEC-002 — user-level preferences only (Out of Scope: a deployment-config
 * admin UI). SPEC-022 BR-022-13: only the **personal** ones — theme,
 * reminders and display defaults. A key that tunes a feature with a
 * Configurações section renders there instead, through the same
 * `ParameterForm`; which screen a key lands on is its registry `surface`.
 */

/**
 * Never prerendered, and this is a tenant-isolation requirement rather than a
 * build detail. The page renders one account's own preferences; a statically
 * generated copy would be built once — from whatever session existed at build
 * time, or none — and then served to every user from the cache. That is
 * cross-tenant leakage arriving through the CDN rather than through a missing
 * WHERE clause, and no RLS policy can catch it, because the query never runs
 * again.
 *
 * It also happens to be why `pnpm build` failed: prerendering ran the config
 * lookup at build time, with no database to reach.
 */
export const dynamic = 'force-dynamic';

export default async function PreferencesPage() {
  const t = await getTranslations('preferences');
  const userId = await tryUserId();

  return (
    <PageShell title={t('title')} description={t('description')}>
      {!userId ? <EmptyState title={t('signedOut')} /> : <ParameterForm surface="preferences" />}
    </PageShell>
  );
}
