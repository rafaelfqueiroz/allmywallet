import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AssetId, isUuid } from '@/core/shared/ids';
import { loadContractTermsForm } from '@/app/(app)/fixed-income/data';
import { supplyContractTermsAction } from '@/app/(app)/fixed-income/actions';
import { ContractTermsForm } from '@/app/(app)/fixed-income/_components/ContractTermsForm';
import { tryUserId } from '@/lib/session';
import { PageShell } from '@/components/patterns/page-shell';
import { EmptyState } from '@/components/patterns/empty-state';
import { Stack } from '@/components/layout/stack';
import { Text } from '@/components/ui/text';

/**
 * SPEC-020 BR-020-19 / SPEC-009 BR-009-13 — the "Needs attention" gate's own
 * resolution screen: a held fixed-income contract whose indexer or contracted
 * rate could not be read from the extract. Reached from the dashboard's
 * queue (`AttentionQueue`) and from `core/onboarding/gates.ts`'s
 * `fixed_income_contract` resolution — never from onboarding's own page,
 * which only links to it (BR-020-15: no second queue lives there).
 *
 * Never statically prerendered: this renders one tenant's own contract, the
 * same reasoning as every other tenant-scoped detail page in this app.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ readonly assetId: string }>;
}

export default async function FixedIncomeContractPage({ params }: PageProps) {
  const t = await getTranslations('fixedIncome');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell title={t('title')}>
        <EmptyState title={t('signedOut')} />
      </PageShell>
    );
  }

  const { assetId: rawAssetId } = await params;
  // A malformed id in the URL is a page that does not exist, not a fault:
  // `AssetId.of` throws on a non-UUID, which would render a 500.
  if (!isUuid(rawAssetId)) notFound();
  const assetId = AssetId.of(rawAssetId);
  const form = await loadContractTermsForm(userId, assetId);

  // `null` means this tenant holds no fixed-income contract for this asset —
  // RLS already scopes the read to the tenant, so this is the honest answer
  // whether the asset does not exist at all or simply is not this user's.
  if (form === null) notFound();

  return (
    <PageShell
      width="narrow"
      title={t('title')}
      description={t('assetLabel', { code: form.assetCode, name: form.assetName })}
    >
      <Stack gap="md">
        {/* BR-020-19 — plainly: this contract cannot be valued, so portfolio
            value is understated until the rate is supplied. Said here again,
            not only in the dashboard's queue item, because a user can land on
            this screen directly (a bookmark, a shared link) without ever
            reading the queue's own copy. */}
        <Text size="sm" tone="muted">
          {t('why')}
        </Text>
        <ContractTermsForm
          assetId={assetId}
          indexer={form.indexer}
          ratePercent={form.ratePercent}
          action={supplyContractTermsAction}
        />
      </Stack>
    </PageShell>
  );
}
