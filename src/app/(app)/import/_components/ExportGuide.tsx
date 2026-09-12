import { getTranslations } from 'next-intl/server';
import { ExportGuideContent } from '@/components/onboarding/export-guide-content';
import { Section } from '@/components/patterns/section';

/**
 * SPEC-005 / SPEC-020 — the guided onboarding: how to export the three
 * extracts from investidor.b3.com.br, and which date range to ask for.
 *
 * **Why this is a first-class screen surface and not a help-centre link.**
 * DL-005-01 chose file import over an API knowing its cost is manual friction;
 * B3's APIs are B2B-only and credential scraping was rejected outright
 * (SPEC-003 DL-003-05). The export is therefore the *only* way custody data
 * enters this product, and every user has to do it — repeatedly. Instructions
 * a step away from the upload button are instructions half the users never
 * find, and a user who uploads the wrong file or a truncated date range gets a
 * ledger that is quietly incomplete rather than an error.
 *
 * **The body is shared, not restated.** `ExportGuideContent`
 * (`src/components/onboarding/`) is the one copy of the steps, the diagrams,
 * the earliest-date advice and the verification stamp — SPEC-020 owns this
 * content now, and `/onboarding` renders the exact same component. This file
 * is left holding only the `Section` framing (`/import`'s own title and lead,
 * which differ by whether this is a first or a returning run).
 *
 * **No screenshots of investidor.b3.com.br** (BR-020-23, DL-020-06). The guide
 * used to crop screenshots to a "chrome band" carrying no account data; #97
 * replaced that with diagrams this project draws itself, because the same B3
 * redesign that breaks a parser silently invalidates a screenshot, and a stale
 * screenshot is worse than none — it walks a user confidently to a button that
 * has moved. `public/guia-b3/*.png` no longer exists in this repository.
 */
export async function ExportGuide({ firstRun }: { readonly firstRun: boolean }) {
  const t = await getTranslations('import.guide');

  return (
    <Section title={t('title')} description={firstRun ? t('firstRunLead') : t('returningLead')}>
      <ExportGuideContent />
    </Section>
  );
}
