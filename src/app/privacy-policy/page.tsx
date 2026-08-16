import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { loadPublishedRetentionWindows } from '@/app/privacy-policy/data';
import { PageShell } from '@/components/patterns/page-shell';
import { Section } from '@/components/patterns/section';
import { Stack } from '@/components/layout/stack';
import { List, ListItem } from '@/components/layout/list';
import { Text } from '@/components/ui/text';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CURRENT_PRIVACY_POLICY_VERSION } from '@/app/privacy-policy/policy-version';
import { DATA_PROTECTION_CONTACT } from '@/app/privacy-policy/contact';

/**
 * SPEC-004 BR-004-15..18 — the published privacy policy.
 *
 * **Public and unauthenticated on purpose.** A data subject deciding whether
 * to create an account has to be able to read this first; a policy behind a
 * sign-in wall is a policy disclosed after the decision it exists to inform.
 *
 * Two claims here are the ones the whole product is arranged around, so they
 * are stated near the top rather than buried in a list: **no credential is
 * ever collected** (SPEC-003 BR-003-08) and **CPF is discarded at parse time**
 * (BR-004-02). Both are architectural facts, not policy promises — which is
 * what makes them safe to publish.
 *
 * `force-dynamic` because the retention windows are read from the SPEC-002
 * registry (BR-004-14: they are range-constrained config, not constants). A
 * prerendered copy would freeze whatever the defaults were at build time and
 * then misstate the real windows the moment an operator changed one — a
 * privacy policy that quietly disagrees with the system it describes.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('privacyPolicy');
  return { title: t('title'), description: t('description') };
}

export default async function PrivacyPolicyPage() {
  const t = await getTranslations('privacyPolicy');

  const { deletionWindowDays, auditMonths } = await loadPublishedRetentionWindows();

  const subprocessors = [
    { id: 'google', international: true },
    { id: 'hostinger', international: false },
    { id: 'sentry', international: true },
    { id: 'brapi', international: false },
  ] as const;

  const legalBases = [
    'contract',
    'legalObligation',
    'consentReminders',
    'consentAnalytics',
  ] as const;

  return (
    <PageShell width="narrow" title={t('title')} description={t('description')}>
      <Stack gap="xl">
        <Text tone="muted" size="xs">
          {t('version', { version: CURRENT_PRIVACY_POLICY_VERSION })}
        </Text>

        <Section title={t('controller.title')}>
          <Stack gap="sm">
            <Text tone="muted">{t('controller.body')}</Text>
            <Text>
              {t('controller.contactLabel')}:{' '}
              <a href={`mailto:${DATA_PROTECTION_CONTACT}`} className="underline">
                {DATA_PROTECTION_CONTACT}
              </a>
            </Text>
          </Stack>
        </Section>

        {/* SPEC-003 BR-003-08 and SPEC-004 BR-004-02. Stated as their own
            sections because they are the two questions a Brazilian investor
            asks first, and because both are enforced in code rather than
            promised in prose. */}
        <Section title={t('credentials.title')}>
          <Text tone="muted">{t('credentials.body')}</Text>
        </Section>

        <Section title={t('cpf.title')}>
          <Text tone="muted">{t('cpf.body')}</Text>
        </Section>

        <Section title={t('legalBases.title')} description={t('legalBases.description')}>
          <List gap="md">
            {legalBases.map((id) => (
              <ListItem key={id} separated>
                <Stack gap="xs">
                  <Text weight="medium">{t(`legalBases.items.${id}.purpose`)}</Text>
                  <Text tone="muted">{t(`legalBases.items.${id}.basis`)}</Text>
                </Stack>
              </ListItem>
            ))}
          </List>
        </Section>

        <Section title={t('retention.title')} description={t('retention.description')}>
          <List gap="sm">
            <ListItem>
              <Text tone="muted">{t('retention.ledger')}</Text>
            </ListItem>
            <ListItem>
              {/* Read from the registry, not hardcoded: BR-004-14 makes these
                  windows configuration, and a policy that names a different
                  number than the scheduler enforces is a false statement. */}
              <Text tone="muted">
                {t('retention.deletionWindow', { days: deletionWindowDays })}
              </Text>
            </ListItem>
            <ListItem>
              <Text tone="muted">{t('retention.audit', { months: auditMonths })}</Text>
            </ListItem>
            <ListItem>
              <Text tone="muted">{t('retention.backups')}</Text>
            </ListItem>
          </List>
        </Section>

        <Section title={t('rights.title')}>
          <Stack gap="sm">
            <Text tone="muted">{t('rights.body')}</Text>
            <Text>
              <Link href="/privacy" className="underline">
                {t('rights.link')}
              </Link>
            </Text>
          </Stack>
        </Section>

        {/* BR-004-18 — the subprocessor inventory. A table rather than prose
            because the international-transfer column is the load-bearing one:
            art. 33 makes each `yes` a disclosure obligation, and a reader has
            to be able to find them at a glance. */}
        <Section title={t('subprocessors.title')} description={t('subprocessors.description')}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('subprocessors.columns.name')}</TableHead>
                <TableHead>{t('subprocessors.columns.purpose')}</TableHead>
                <TableHead>{t('subprocessors.columns.location')}</TableHead>
                <TableHead>{t('subprocessors.columns.transfer')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {subprocessors.map(({ id, international }) => (
                <TableRow key={id}>
                  <TableCell>{t(`subprocessors.items.${id}.name`)}</TableCell>
                  <TableCell>{t(`subprocessors.items.${id}.purpose`)}</TableCell>
                  <TableCell>{t(`subprocessors.items.${id}.location`)}</TableCell>
                  <TableCell>
                    {international ? t('subprocessors.yes') : t('subprocessors.no')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>

        <Section title={t('internationalTransfer.title')}>
          <Text tone="muted">{t('internationalTransfer.body')}</Text>
        </Section>
      </Stack>
    </PageShell>
  );
}
