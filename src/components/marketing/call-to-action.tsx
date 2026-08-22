import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Stack } from '@/components/layout/stack';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * The closing ask.
 *
 * Labelled by its own heading rather than carrying an `aria-label`: the
 * heading is already on screen, and duplicating it as an attribute is one more
 * string to keep in step with the catalogue for no benefit to anyone.
 */
export function CallToAction() {
  const t = useTranslations('marketing.cta');

  return (
    <section aria-labelledby="marketing-cta-title">
      <Card className="bg-muted/40">
        <CardHeader>
          <CardTitle asChild>
            <h2 id="marketing-cta-title" className="text-xl">
              {t('title')}
            </h2>
          </CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Stack gap="md" align="start">
            <Button asChild size="lg" className="h-11 px-6 text-base">
              <Link href="/signin">{t('button')}</Link>
            </Button>
          </Stack>
        </CardContent>
      </Card>
    </section>
  );
}
