import { useTranslations } from 'next-intl';

/**
 * Placeholder landing page. SPEC-001 replaces this with the sign-in surface and
 * SPEC-013 with the dashboard behind it.
 */
export default function HomePage() {
  const t = useTranslations('app');

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-4 px-6">
      <h1 className="text-3xl font-semibold tracking-tight">{t('name')}</h1>
      <p className="text-muted-foreground">{t('tagline')}</p>
    </main>
  );
}
