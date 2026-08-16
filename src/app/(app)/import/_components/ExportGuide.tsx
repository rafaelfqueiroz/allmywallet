import { getTranslations } from 'next-intl/server';
import { Section } from '@/components/patterns/section';
import { Stack } from '@/components/layout/stack';
import { List, ListItem } from '@/components/layout/list';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Note } from '@/components/patterns/note';

/**
 * SPEC-005 — the guided onboarding: how to export the three extracts from
 * investidor.b3.com.br, and which date range to ask for.
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
 * **The earliest-available-date advice is the part that cannot be corrected
 * later.** B3 serves a limited history, so an export taken from "last month"
 * permanently omits everything before it — and SPEC-007's cost basis is a
 * replay over the whole ledger, so a missing early purchase does not show up
 * as a gap in a chart, it shows up as a *wrong preço médio* on a position the
 * user still holds. Hence the emphasis here rather than a footnote.
 *
 * ---------------------------------------------------------------------------
 * NO SCREENSHOTS. SPEC-005's acceptance criterion asks for them and they are
 * deliberately absent: investidor.b3.com.br is behind a login and every view of
 * it shows a real CPF and real holdings. DV-24 / TS-19 keep real extracts out
 * of this repository for exactly that reason, and a screenshot is the same
 * data in a different file format. Capturing them needs a throwaway account
 * with fabricated holdings, which is an operational task, not a code one.
 * ---------------------------------------------------------------------------
 */

const B3_PORTAL_URL = 'https://investidor.b3.com.br';

/** The three extracts, in the order the guide walks through them. */
const EXTRACT_STEPS = ['movimentacao', 'negociacao', 'posicao'] as const;

export async function ExportGuide({ firstRun }: { readonly firstRun: boolean }) {
  const t = await getTranslations('import.guide');

  return (
    <Section title={t('title')} description={firstRun ? t('firstRunLead') : t('returningLead')}>
      <Stack gap="md">
        <List gap="sm" as="ol">
          {EXTRACT_STEPS.map((step, index) => (
            <ListItem key={step} separated>
              <Stack gap="xs">
                <Text weight="medium">{t(`steps.${step}.title`, { number: index + 1 })}</Text>
                <Text size="sm" tone="muted">
                  {t(`steps.${step}.path`)}
                </Text>
                <Text size="sm">{t(`steps.${step}.why`)}</Text>
              </Stack>
            </ListItem>
          ))}
        </List>

        {/* The one instruction that cannot be undone by re-importing later. */}
        <Note>{t('earliestDate')}</Note>

        <Text size="sm" tone="muted">
          {t('anyOrder')}
        </Text>

        <div>
          <Button asChild variant="outline">
            {/* rel="noreferrer": this is an external financial portal and the
                referrer would leak which page of this app the user came from. */}
            <a href={B3_PORTAL_URL} target="_blank" rel="noreferrer">
              {t('openPortal')}
            </a>
          </Button>
        </div>
      </Stack>
    </Section>
  );
}
