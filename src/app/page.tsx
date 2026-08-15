import { useTranslations } from 'next-intl';
import { AuthShell } from '@/components/patterns/auth-shell';

/**
 * Placeholder landing page. #37 replaces this with the real public surface;
 * SPEC-013 puts the dashboard behind it.
 */
export default function HomePage() {
  const t = useTranslations('app');

  return <AuthShell title={t('name')} description={t('tagline')} />;
}
