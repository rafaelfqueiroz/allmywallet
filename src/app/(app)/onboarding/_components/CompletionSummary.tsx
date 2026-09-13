import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { OnboardingSteps } from '@/core/onboarding/status';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/**
 * SPEC-020 BR-020-04 — "creating a first wallet is offered afterwards and is
 * **never** a gate." Rendered only when `OnboardingStatus.stage === 'done'`
 * (BR-020-03: complete at the first committed import, nothing else).
 *
 * A plain `Stack`/`Text` block rather than `EmptyState`: that pattern's own
 * contract is "explains an absence" (`role="status"`, DS-25), and this screen
 * is the opposite of an absence — reusing it would say the wrong thing to a
 * screen reader announcing the region's role.
 *
 * The wallet link is conditional on `!steps.firstWallet` and is deliberately
 * the secondary action — a `link`-styled button beside the primary
 * `dashboardLink` — because BR-020-04's "offered" is not "required", and equal
 * visual weight would say otherwise.
 */
export async function CompletionSummary({ steps }: { readonly steps: OnboardingSteps }) {
  const t = await getTranslations('onboarding.done');

  return (
    <Stack gap="sm">
      <Text as="p" weight="medium">
        {t('title')}
      </Text>
      <Text as="p" size="sm" tone="muted">
        {t('description')}
      </Text>
      <Cluster gap="sm">
        <Button asChild>
          <Link href="/dashboard">{t('dashboardLink')}</Link>
        </Button>
        {!steps.firstWallet && (
          <Button asChild variant="link">
            <Link href="/wallets">{t('walletLink')}</Link>
          </Button>
        )}
      </Cluster>
    </Stack>
  );
}
