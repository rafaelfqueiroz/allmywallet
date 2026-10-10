import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { loadAccountProfile } from '@/app/account-profile';
import { PageShell } from '@/components/patterns/page-shell';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/**
 * SPEC-022 BR-022-12 — **Conta**: the profile, read-only, exactly as Google
 * supplies it, and a link to Privacidade for export and deletion.
 *
 * It has no controls of its own on purpose. The four fields SPEC-001 BR-001-05
 * allows are Google's, so there is nothing here to edit; and export, consent
 * and deletion stay on Privacidade (SPEC-004 BR-004-09) — duplicating them here
 * would give one right two places to drift apart.
 *
 * Built with the account menu (#205) because the menu links here, and a menu
 * item that 404s is worse than none (DS-26). #207 owns the Preferências split.
 *
 * `force-dynamic` for the tenant-isolation reason `preferences/page.tsx` gives:
 * a prerendered copy of one person's profile would be served to everyone.
 */
export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const t = await getTranslations('account');
  const profile = await loadAccountProfile();

  if (!profile) {
    return (
      <PageShell title={t('title')} description={t('description')}>
        <EmptyState title={t('signedOut')} />
      </PageShell>
    );
  }

  return (
    <PageShell title={t('title')} description={t('description')}>
      <Stack gap="xl">
        <Section title={t('profileTitle')} description={t('source')}>
          <Cluster gap="lg" align="center">
            {profile.imageUrl && (
              // A plain <img>: the picture is Google's, and `images.unoptimized`
              // means next/image would add nothing (next.config.ts).
              <img
                src={profile.imageUrl}
                alt={t('picture')}
                referrerPolicy="no-referrer"
                className="size-16 rounded-full object-cover"
              />
            )}
            <Stack gap="sm">
              <Stack gap="xs">
                <Text size="xs" tone="muted">
                  {t('name')}
                </Text>
                <Text weight="medium">{profile.name ?? t('notProvided')}</Text>
              </Stack>
              <Stack gap="xs">
                <Text size="xs" tone="muted">
                  {t('email')}
                </Text>
                <Text>{profile.email}</Text>
              </Stack>
            </Stack>
          </Cluster>
        </Section>

        <Section title={t('privacyTitle')} description={t('privacyBody')}>
          <div>
            <Button asChild variant="outline">
              <Link href="/privacy">{t('privacyLink')}</Link>
            </Button>
          </div>
        </Section>
      </Stack>
    </PageShell>
  );
}
