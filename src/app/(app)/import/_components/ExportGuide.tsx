import Image from 'next/image';
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
 * THE SCREENSHOTS, AND WHAT IS DELIBERATELY NOT IN THEM
 *
 * AC-1 asks for screenshots, and the reason they took so long is DV-24 /
 * TS-19: investidor.b3.com.br is behind a login and a full-page capture shows
 * the account holder's name, their institution and every position they hold
 * with its quantity and value — the same data a real extract carries, in a
 * different file format, and just as unwelcome in this repository.
 *
 * So each image is cropped to the **chrome band**: the tab bar, the period
 * selector and the download button. That is the whole instructional payload —
 * which tab, and which button — and it carries no holdings, no totals, no
 * institution and no name. The originals are not in this repository in any
 * form; these were produced from them and the crop is the artefact, not a
 * redaction layered over a full image.
 * ---------------------------------------------------------------------------
 */

const B3_PORTAL_URL = 'https://investidor.b3.com.br';

/** The pixel size the files actually are, so nothing reflows while they load. */
const SCREENSHOT_WIDTH = 1600;
const SCREENSHOT_HEIGHT = 125;

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
                {/*
                  AC-1's screenshot. `alt` describes the *action* rather than
                  the picture — a screen reader user needs "the Movimentação
                  tab, and Baixar on the right", not "a screenshot of a web
                  page". The intrinsic size is declared so the step does not
                  reflow as the image arrives.
                */}
                <Image
                  src={`/guia-b3/${step}.png`}
                  alt={t(`steps.${step}.screenshotAlt`)}
                  width={SCREENSHOT_WIDTH}
                  height={SCREENSHOT_HEIGHT}
                  className="rounded-md border"
                  sizes="(min-width: 768px) 42rem, 100vw"
                />
              </Stack>
            </ListItem>
          ))}
        </List>

        {/* The one instruction that cannot be undone by re-importing later. */}
        <Note>{t('earliestDate')}</Note>

        <Text size="sm" tone="muted">
          {t('anyOrder')}
        </Text>

        {/*
          Said out loud rather than left to be noticed: a reader looking at a
          cropped screenshot of their own broker deserves to know the crop is
          the point, not an accident of capture.
        */}
        <Text size="xs" tone="muted">
          {t('screenshotNote')}
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
