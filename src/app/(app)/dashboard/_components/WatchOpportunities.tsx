import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { WatchOpportunities as WatchOpportunitiesData } from '@/app/(app)/watch/data';
import { WATCH_RULES_PATH, watchRulePath } from '@/lib/watch-paths';
import { Section } from '@/components/patterns/section';
import { StateBadge } from '@/components/patterns/state-badge';
import { Money } from '@/app/money';
import { List, ListItem } from '@/components/layout/list';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/**
 * SPEC-022 BR-022-07 — the Painel's card listing **held assets currently in a
 * buy or sell state** (SPEC-018), each linking to its rule under Configurações
 * › Observar preços. The Painel summarises; the rule, its bounds and its last
 * e-mail stay on the rules screen, which the header link opens.
 *
 * - **Reads SPEC-018's existing evaluation** (`loadWatchOpportunities`), the
 *   same `evaluateRule` over the same stored quote every other screen shows, so
 *   it requests no quote and cannot disagree with the rules screen (BR-018-11,
 *   BR-018-14).
 * - **Colour and a text label (DL-018-06, BR-018-17).** The state renders
 *   through `StateBadge`, the opportunity tokens with a required label.
 * - **The user's own rule, never a judgement (BR-018-18)**: each line names the
 *   bound the user set — "no ou abaixo do seu limite de compra de R$ 11,00".
 * - Amounts are `Money`, so they mask with every other figure (BR-022-24).
 */
export async function WatchOpportunities({
  opportunities,
}: {
  readonly opportunities: WatchOpportunitiesData;
}) {
  const t = await getTranslations('dashboard.opportunities');
  const tState = await getTranslations('watch.stateLabel');
  const { hasRules, items } = opportunities;

  return (
    <Section
      title={t('title')}
      actions={
        <Button asChild variant="link" size="sm">
          <Link href={WATCH_RULES_PATH} aria-label={t('rulesLinkLabel')}>
            {t('rulesLink')}
          </Link>
        </Button>
      }
    >
      {items.length === 0 ? (
        <Text size="sm" tone="muted">
          {hasRules ? t('empty') : t('emptyNoRules')}
        </Text>
      ) : (
        <Stack gap="sm">
          <List gap="sm">
            {items.map((item) => {
              const stateLabel = tState(item.state);
              return (
                <ListItem key={item.assetId} separated>
                  <Cluster justify="between" gap="sm" align="center">
                    <Stack gap="xs">
                      <span className="font-medium">{item.code}</span>
                      <Text as="span" size="xs" tone="muted">
                        {t('price')} <Money value={item.price} /> ·{' '}
                        {item.threshold === null ? (
                          t('between', { stateLabel })
                        ) : (
                          <>
                            {t('bound', {
                              boundSide: item.matched === 'lower' ? 'lower' : 'upper',
                              stateLabel,
                            })}{' '}
                            <Money value={item.threshold} />
                          </>
                        )}
                      </Text>
                    </Stack>
                    <Cluster gap="sm" align="center">
                      <StateBadge state={item.state} label={stateLabel} />
                      <Button asChild variant="link" size="sm">
                        <Link
                          href={watchRulePath(item.assetId)}
                          aria-label={t('ruleLinkLabel', { assetCode: item.code })}
                        >
                          {t('ruleLink')}
                        </Link>
                      </Button>
                    </Cluster>
                  </Cluster>
                </ListItem>
              );
            })}
          </List>
          <Text size="xs" tone="muted">
            {t('notAdvice')}
          </Text>
        </Stack>
      )}
    </Section>
  );
}
