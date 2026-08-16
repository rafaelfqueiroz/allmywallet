import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { tryUserId } from '@/lib/session';
import { CONSENT_PURPOSES, type ConsentPurpose } from '@/core/privacy/ports';
import { loadConsentStates, loadDeletionStatus } from '@/app/(settings)/privacy/data';
import { requestAccountDeletionAction, setConsentAction } from '@/app/(settings)/privacy/actions';
import { PageShell } from '@/components/patterns/page-shell';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { List, ListItem } from '@/components/layout/list';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/**
 * SPEC-004 — self-service export, deletion and consent management
 * (BR-004-06/09/11).
 *
 * Never prerendered, for the same tenant-isolation reason
 * `preferences/page.tsx` gives at length: this renders one account's own
 * consent and deletion state, and a statically generated copy would be built
 * once and then served to everyone from the CDN. That is cross-tenant leakage
 * arriving past RLS rather than through it, because the query never runs again.
 */
export const dynamic = 'force-dynamic';

export default async function PrivacyPage() {
  const t = await getTranslations('privacy');
  const userId = await tryUserId();

  if (!userId) {
    return (
      <PageShell width="narrow" title={t('title')} description={t('description')}>
        <EmptyState title={t('signedOut')} />
      </PageShell>
    );
  }

  const [consents, deletionStatus] = await Promise.all([
    loadConsentStates(userId),
    loadDeletionStatus(userId),
  ]);

  return (
    <PageShell width="narrow" title={t('title')} description={t('description')}>
      <Stack gap="xl">
        <Section title={t('consent.title')} description={t('consent.description')}>
          <List gap="md">
            {consents.map((state) => (
              <ListItem key={state.purpose} separated>
                <ConsentToggle purpose={state.purpose} granted={state.granted} />
              </ListItem>
            ))}
          </List>
        </Section>

        <Section title={t('export.title')} description={t('export.description')}>
          {/* BR-004-06: both machine-readable formats are offered, because
              "portable" means a format the next system can actually read —
              JSON for a tool, CSV for a spreadsheet. Plain links rather than
              form submissions: an export is a GET of the caller's own data. */}
          <Cluster gap="sm">
            <Button asChild variant="outline">
              <Link href="/api/privacy/export/json">{t('export.json')}</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/api/privacy/export/csv">{t('export.csv')}</Link>
            </Button>
          </Cluster>
        </Section>

        <Section title={t('deletion.title')} description={t('deletion.description')}>
          {deletionStatus?.deletionRequestedAt ? (
            /* BR-004-11: a pending request is stated with its date, because
               the review window is the user's opportunity to change their
               mind and it is worthless if they cannot see when it started.
               `role="status"` so a screen reader hears the state change after
               the form submits and the page re-renders. */
            <Text role="status" tone="muted">
              {t('deletion.pending', {
                requestedAt: deletionStatus.deletionRequestedAt.toLocaleDateString('pt-BR'),
              })}
            </Text>
          ) : (
            <form action={requestAccountDeletionAction}>
              <Button type="submit" variant="destructive">
                {t('deletion.confirm')}
              </Button>
            </form>
          )}
        </Section>

        <Text tone="muted">
          <Link href="/privacy-policy" className="underline">
            {t('policyLink')}
          </Link>
        </Text>
      </Stack>
    </PageShell>
  );
}

async function ConsentToggle({ purpose, granted }: { purpose: ConsentPurpose; granted: boolean }) {
  const t = await getTranslations('privacy');
  // Every purpose declared in the domain (`CONSENT_PURPOSES`) gets a message
  // key here — a purpose with no translation would otherwise render raw.
  void CONSENT_PURPOSES;

  return (
    <Cluster justify="between" align="start" gap="md">
      <Stack gap="xs">
        <Text weight="medium">{t(`consent.purposes.${purpose}.label`)}</Text>
        <Text tone="muted">{t(`consent.purposes.${purpose}.description`)}</Text>
      </Stack>
      <form action={setConsentAction}>
        <input type="hidden" name="purpose" value={purpose} />
        {/* Toggle: currently granted → submitting revokes ('off'); currently
            not granted → submitting grants ('on'). `setConsentAction` reads
            exactly this value, never the button's own label. */}
        <input type="hidden" name="granted" value={granted ? 'off' : 'on'} />
        <Button type="submit" variant="outline" size="sm">
          {granted ? t('consent.revoke') : t('consent.grant')}
        </Button>
      </form>
    </Cluster>
  );
}
