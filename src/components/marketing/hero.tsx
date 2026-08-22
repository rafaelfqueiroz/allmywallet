import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Stack } from '@/components/layout/stack';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/**
 * The page's one `h1`, and the only place the product gets to make its claim
 * in a sentence.
 *
 * The note under the call to action is not decoration: SPEC-001 BR-001-01 and
 * SPEC-003 BR-003-08 are the two facts a Brazilian investor weighs before
 * handing any tool their portfolio, and stating them at the point of decision
 * is the honest place for them — the same reasoning that puts BR-001-12's
 * no-recovery notice on the sign-in page itself.
 */
export function Hero() {
  const t = useTranslations('marketing.hero');

  return (
    <section className="pt-12 pb-4 sm:pt-20">
      <Stack gap="lg" align="start">
        <Stack gap="md">
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            {t('title')}
          </h1>
          <p className="max-w-2xl text-base text-pretty text-muted-foreground sm:text-lg">
            {t('description')}
          </p>
        </Stack>
        <Stack gap="sm" align="start">
          {/* Deliberately larger than the system's `lg` button. A hero call to
              action is the one control on the page with no competition for
              attention, and sizing it from the same scale as a toolbar button
              is what makes a landing page look like a settings screen. The
              override is local to marketing rather than a new system size, so
              nothing in the application can drift onto it. */}
          <Button asChild size="lg" className="h-11 px-6 text-base">
            <Link href="/signin">{t('cta')}</Link>
          </Button>
          <Text tone="muted" size="xs" className="max-w-prose">
            {t('note')}
          </Text>
        </Stack>
      </Stack>
    </section>
  );
}
