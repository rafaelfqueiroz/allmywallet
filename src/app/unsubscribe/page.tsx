import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { verifyUnsubscribeToken } from '@/lib/unsubscribe-token';
import { confirmUnsubscribeAction } from '@/app/unsubscribe/actions';
import { PageShell } from '@/components/patterns/page-shell';
import { Section } from '@/components/patterns/section';
import { Stack } from '@/components/layout/stack';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';

/**
 * SPEC-018 BR-018-26 — public and unauthenticated on purpose, the same
 * reasoning as `src/app/privacy-policy/page.tsx`: the person this page is for
 * is, by construction, reading an email and not signed in on this device.
 *
 * This page only ever **reads** the token to decide what to show. The write
 * — revoking `email_reminders` — happens in `confirmUnsubscribeAction`
 * (`actions.ts`), behind the form's POST, never here on the GET. See that
 * file's doc comment for why a mail-client link prefetch makes that
 * distinction load-bearing rather than stylistic.
 *
 * One generic message covers every invalid-token case — malformed, wrong
 * purpose, bad signature, not a UUID — matching
 * `verifyUnsubscribeToken`'s own "`null` for every failure" contract: telling
 * an anonymous visitor which part of a broken link failed helps nobody but an
 * attacker probing the token format.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('email.unsubscribePage');
  return { title: t('title') };
}

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function UnsubscribePage({ searchParams }: PageProps) {
  const t = await getTranslations('email.unsubscribePage');
  const params = await searchParams;

  if (params.done === '1') {
    return (
      <PageShell width="narrow" title={t('title')}>
        <Text>{t('done')}</Text>
      </PageShell>
    );
  }

  const tokenParam = params.token;
  const token = typeof tokenParam === 'string' ? tokenParam : null;
  const userId = token === null ? null : verifyUnsubscribeToken(token);

  // `token === null` is redundant with `userId === null` at runtime (there is
  // no way to get a non-null `userId` from a null `token`), but TypeScript
  // cannot see across the ternary above — checking both here, rather than
  // asserting one from the other, is what lets the JSX below use `token` as a
  // plain `string` with no cast and no `!` (DV-03).
  if (userId === null || token === null) {
    return (
      <PageShell width="narrow" title={t('title')}>
        <Text tone="muted">{t('invalid')}</Text>
      </PageShell>
    );
  }

  return (
    <PageShell width="narrow" title={t('title')}>
      <Section title={t('confirmTitle')}>
        <Stack gap="md">
          <Text tone="muted">{t('confirmBody')}</Text>
          <form action={confirmUnsubscribeAction}>
            <input type="hidden" name="token" value={token} />
            <Button type="submit" variant="destructive">
              {t('confirmButton')}
            </Button>
          </form>
        </Stack>
      </Section>
    </PageShell>
  );
}
