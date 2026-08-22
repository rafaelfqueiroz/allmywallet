import Link from 'next/link';
import { Download, EyeOff, KeyRound, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { List, ListItem } from '@/components/layout/list';
import { Section } from '@/components/patterns/section';
import { Text } from '@/components/ui/text';

/**
 * The three data claims, stated on the public page rather than only in the
 * policy behind it.
 *
 * All three are architectural facts, not intentions, which is what makes them
 * safe to publish: **no credential is ever collected** (SPEC-003 BR-003-08 —
 * there is no field, no column and no code path), **CPF is discarded at parse
 * time** (SPEC-004 BR-004-02 — before the first write, so it reaches neither
 * the ledger, nor `import_rows.raw_payload`, nor the logs), and **export and
 * deletion are self-service** (BR-004-06/09).
 *
 * A list rather than headings: these are peer assertions at one level, and
 * three more `h3`s here would compete with the feature grid's outline for no
 * navigational gain.
 */
const POINTS: readonly { readonly id: string; readonly icon: LucideIcon }[] = [
  { id: 'credentials', icon: KeyRound },
  { id: 'cpf', icon: EyeOff },
  { id: 'portability', icon: Download },
];

export function TrustPoints() {
  const t = useTranslations('marketing.trust');

  return (
    <Section title={t('title')} description={t('description')}>
      <List gap="lg">
        {POINTS.map(({ id, icon: Icon }) => (
          <ListItem key={id} separated>
            <Stack gap="xs">
              <Cluster gap="sm">
                <Icon className="size-4 text-primary" aria-hidden="true" />
                <Text as="span" size="base" weight="semibold">
                  {t(`${id}.title`)}
                </Text>
              </Cluster>
              <Text tone="muted" className="max-w-prose">
                {t(`${id}.description`)}
              </Text>
            </Stack>
          </ListItem>
        ))}
      </List>
      <Link href="/privacy-policy" className="text-sm underline">
        {t('policyLink')}
      </Link>
    </Section>
  );
}
