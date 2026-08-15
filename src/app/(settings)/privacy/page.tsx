import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { tryUserId } from '@/lib/session';
import { CONSENT_PURPOSES, type ConsentPurpose } from '@/core/privacy/ports';
import { loadConsentStates, loadDeletionStatus } from '@/app/(settings)/privacy/data';
import { requestAccountDeletionAction, setConsentAction } from '@/app/(settings)/privacy/actions';

/**
 * SPEC-004 — self-service export, deletion and consent management
 * (BR-004-06/09/11). Never prerendered, for the same tenant-isolation reason
 * `preferences/page.tsx` gives: this renders one account's own data, and a
 * statically generated copy would leak across accounts through the CDN.
 */
export const dynamic = 'force-dynamic';

export default async function PrivacyPage() {
  const t = await getTranslations('privacy');
  const userId = await tryUserId();

  if (!userId) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 px-6 py-10">
        <p role="status" className="text-muted-foreground">
          {t('signedOut')}
        </p>
      </main>
    );
  }

  const [consents, deletionStatus] = await Promise.all([
    loadConsentStates(userId),
    loadDeletionStatus(userId),
  ]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-10 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-medium">{t('consent.title')}</h2>
        <ul className="flex flex-col gap-4">
          {consents.map((state) => (
            <ConsentToggle key={state.purpose} purpose={state.purpose} granted={state.granted} />
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3 border-t pt-6">
        <h2 className="text-lg font-medium">{t('export.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('export.description')}</p>
        <div className="flex gap-3">
          <Link
            href="/api/privacy/export/json"
            className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent"
          >
            {t('export.json')}
          </Link>
          <Link
            href="/api/privacy/export/csv"
            className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent"
          >
            {t('export.csv')}
          </Link>
        </div>
      </section>

      <section className="flex flex-col gap-3 border-t pt-6">
        <h2 className="text-lg font-medium text-destructive">{t('deletion.title')}</h2>
        {deletionStatus?.deletionRequestedAt ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('deletion.pending', {
              requestedAt: deletionStatus.deletionRequestedAt.toLocaleDateString('pt-BR'),
            })}
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{t('deletion.description')}</p>
            <form action={requestAccountDeletionAction}>
              <button
                type="submit"
                className="w-fit rounded-md border border-destructive px-3 py-1.5 text-sm font-medium text-destructive hover:bg-destructive/10"
              >
                {t('deletion.confirm')}
              </button>
            </form>
          </>
        )}
      </section>

      <p className="border-t pt-6 text-sm text-muted-foreground">
        <Link href="/privacy-policy" className="underline">
          {t('policyLink')}
        </Link>
      </p>
    </main>
  );
}

async function ConsentToggle({
  purpose,
  granted,
}: {
  purpose: ConsentPurpose;
  granted: boolean;
}) {
  const t = await getTranslations('privacy');
  // Every purpose declared in the domain (`CONSENT_PURPOSES`) gets a message
  // key here — a purpose with no translation would otherwise render raw.
  void CONSENT_PURPOSES;

  return (
    <li className="flex items-start justify-between gap-4 border-b pb-4 last:border-0">
      <div>
        <p className="font-medium">{t(`consent.purposes.${purpose}.label`)}</p>
        <p className="text-sm text-muted-foreground">
          {t(`consent.purposes.${purpose}.description`)}
        </p>
      </div>
      <form action={setConsentAction}>
        <input type="hidden" name="purpose" value={purpose} />
        {/* Toggle: currently granted → submitting revokes ('off'); currently
            not granted → submitting grants ('on'). `setConsentAction` reads
            exactly this value, never the button's own label. */}
        <input type="hidden" name="granted" value={granted ? 'off' : 'on'} />
        <button
          type="submit"
          className="w-fit rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent"
        >
          {granted ? t('consent.revoke') : t('consent.grant')}
        </button>
      </form>
    </li>
  );
}
