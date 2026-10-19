import { getTranslations } from 'next-intl/server';
import type {
  WatchOpportunities as WatchOpportunitiesData,
  WatchOpportunity,
} from '@/app/(app)/watch/data';
import { WATCH_RULES_PATH, watchRulePath } from '@/lib/watch-paths';
import { CardHeaderLink, CardItemLink, SummaryCard } from '@/components/patterns/summary-card';
import { NodeTable, type NodeColumn, type NodeRow } from '@/components/patterns/node-table';
import { StateBadge } from '@/components/patterns/state-badge';
import { Money } from '@/app/money';
import { Stack } from '@/components/layout/stack';
import { Text } from '@/components/ui/text';

/**
 * SPEC-022 BR-022-18 / DS-65 — a Dashboard card summarises: it lists at most this
 * many opportunities (as the attention queue does, `ATTENTION_QUEUE_LIMIT`) and
 * links to the destination that owns the full list — Configurações › Observar
 * preços, a paged table — rather than growing with the portfolio. 30 held rules
 * crossing a bound would otherwise be 30 list items in the card.
 */
const OPPORTUNITIES_SHOWN = 5;

/**
 * SPEC-022 BR-022-07 — the Dashboard's card listing **held assets currently in a
 * buy or sell state** (SPEC-018), each linking to its rule under Configurações
 * › Observar preços. The Dashboard summarises; the rule, its bounds and its last
 * e-mail stay on the rules screen, which the header link opens.
 *
 * - **Reads SPEC-018's existing evaluation** (`loadWatchOpportunities`), the
 *   same `evaluateRule` over the same stored quote every other screen shows, so
 *   it requests no quote and cannot disagree with the rules screen (BR-018-11,
 *   BR-018-14).
 * - **Colour and a text label (DL-018-06, BR-018-17).** The state renders
 *   through `StateBadge`, the opportunity tokens with a required label.
 * - **The user's own rule, never a judgement (BR-018-18)**: the Gatilho column
 *   is the bound the user set, and the note under the table says so.
 * - Amounts are `Money`, so they mask with every other figure (BR-022-24).
 *
 * **A small aligned table (#243)** — Ativo, Cotação, Gatilho, Estado — as the
 * adjustment frame draws it: figures right-aligned under each other (DS-67)
 * rather than a sentence per asset. The asset code is the link to its rule.
 */
export async function WatchOpportunities({
  opportunities,
}: {
  readonly opportunities: WatchOpportunitiesData;
}) {
  const t = await getTranslations('dashboard.opportunities');
  const tState = await getTranslations('watch.stateLabel');
  const { hasRules, items: all, unknownCount } = opportunities;
  const items = all.slice(0, OPPORTUNITIES_SHOWN);
  const hidden = all.length - items.length;
  // BR-018-16 — said whether or not anything is listed, so an empty list is
  // never read as "nothing crossed" when the price to tell is missing.
  const unknownNote =
    unknownCount > 0 ? (
      <Text size="xs" tone="muted">
        {t('unknown', { count: unknownCount })}
      </Text>
    ) : null;

  /*
   * Widths sized for the Dashboard's narrow column (DS-67 lets a table pass
   * its own), measured in the app's font: a B3 code, a price to R$ 9.999,99,
   * the trigger with its sign, and the state's one-word badge. They sum to
   * about 390px, which the column's 27rem floor holds (`Split side="aside"`);
   * a narrower container scrolls the table rather than collapsing a column.
   */
  const columns: readonly NodeColumn[] = [
    { id: 'asset', header: t('columns.asset'), kind: 'text', width: 7 },
    { id: 'price', header: t('columns.price'), kind: 'money', width: 10 },
    { id: 'trigger', header: t('columns.trigger'), kind: 'money', width: 11 },
    { id: 'state', header: t('columns.state'), kind: 'badge', width: 9 },
  ];

  const rows = items.map((item): NodeRow => ({
    id: item.assetId,
    cells: {
      asset: (
        // WCAG 2.5.3 — the name begins with the visible code.
        <CardItemLink
          href={watchRulePath(item.assetId)}
          ariaLabel={t('ruleLinkLabel', { assetCode: item.code })}
        >
          {item.code}
        </CardItemLink>
      ),
      price: <Money value={item.price} />,
      trigger: <Trigger item={item} t={t} />,
      state: <StateBadge state={item.state} label={tState(item.state)} />,
    },
  }));

  return (
    <SummaryCard
      title={t('title')}
      {...(hidden > 0
        ? {
            link: {
              href: WATCH_RULES_PATH,
              label: t('seeAll', { count: all.length }),
              ariaLabel: t('seeAllLabel', { count: all.length }),
            },
          }
        : {})}
      action={
        <CardHeaderLink
          href={WATCH_RULES_PATH}
          label={t('rulesLink')}
          ariaLabel={t('rulesLinkLabel')}
        />
      }
    >
      {items.length === 0 ? (
        <Stack gap="sm">
          <Text size="sm" tone="muted">
            {hasRules ? t(unknownCount > 0 ? 'emptyWithUnknown' : 'empty') : t('emptyNoRules')}
          </Text>
          {unknownNote}
        </Stack>
      ) : (
        <Stack gap="sm">
          <NodeTable
            columns={columns}
            rows={rows}
            caption={t('caption')}
            noun={t('noun')}
            // Bounded by construction: at most `OPPORTUNITIES_SHOWN` rows, and
            // the card's footer links to the full, paged list.
            pagination={false}
          />
          {unknownNote}
          <Text size="xs" tone="muted">
            {t('notAdvice')}
          </Text>
        </Stack>
      )}
    </SummaryCard>
  );
}

/**
 * BR-018-18 — the bound the user set, as "≤ R$ 11,00" or "≥ R$ 50,00". The
 * bounds are inclusive (`evaluateRule` matches at the bound itself), so the
 * signs are ≤ and ≥ rather than the frame's < and >, which would misstate a
 * price sitting exactly on the bound. The sign is read aloud as words.
 * When neither bound matched, the state is the user's own band between them.
 */
function Trigger({
  item,
  t,
}: {
  readonly item: WatchOpportunity;
  readonly t: Awaited<ReturnType<typeof getTranslations<'dashboard.opportunities'>>>;
}) {
  if (item.threshold === null) return <span>{t('trigger.between')}</span>;
  const side = item.matched === 'lower' ? 'lower' : 'upper';
  return (
    <span className="whitespace-nowrap">
      <span aria-hidden>{side === 'lower' ? '≤' : '≥'}</span>
      <span className="sr-only">{t(`trigger.${side}`)}</span> <Money value={item.threshold} />
    </span>
  );
}
