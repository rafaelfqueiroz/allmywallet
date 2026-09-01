import { getTranslations } from 'next-intl/server';
import type { Money as MoneyValue } from '@/core/shared/money';
import type { OpportunityState } from '@/core/opportunity/ports';
import { formatCurrency, formatDateTime } from '@/i18n/format';
import { tryUserId } from '@/lib/session';
import { loadWatchView, type WatchRuleRow } from '@/app/(app)/watch/data';
import {
  createRuleAction,
  deleteRuleAction,
  setRuleMutedAction,
  updateRuleAction,
} from '@/app/(app)/watch/actions';
import { RuleForm, type RuleFormLabels } from '@/app/(app)/watch/_components/RuleForm';
import { PageShell } from '@/components/patterns/page-shell';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { Note } from '@/components/patterns/note';
import { ActionForm } from '@/components/patterns/action-form';
import { StateBadge } from '@/components/patterns/state-badge';
import { Money } from '@/components/patterns/money';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { List, ListItem } from '@/components/layout/list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/**
 * SPEC-018 — the watch screen (BR-018-19/20). Lists every held, eligible
 * asset with its current price, both bounds, the evaluated state and the
 * time of the last email sent for it; offers a rule form for held eligible
 * assets with none yet; and states, for a held CDB/LCI/LCA, that it has no
 * market price to watch (BR-018-02).
 *
 * Never statically prerendered: this renders one tenant's own holdings and
 * rules, so a cached copy built once would be served to every visitor — the
 * same tenant-isolation reasoning `(settings)/preferences/page.tsx` gives at
 * length.
 */
export const dynamic = 'force-dynamic';

export default async function WatchPage() {
  const t = await getTranslations('watch');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell title={t('title')}>
        <EmptyState title={t('signedOut')} />
      </PageShell>
    );
  }

  const view = await loadWatchView(userId);

  const stateOptions: Readonly<Record<OpportunityState, string>> = {
    buy: t('stateLabel.buy'),
    hold: t('stateLabel.hold'),
    sell: t('stateLabel.sell'),
  };

  const formLabels: RuleFormLabels = {
    hint: t('boundsHint'),
    lowerPriceLabel: t('lowerPriceLabel'),
    lowerStateLabel: t('lowerStateLabel'),
    upperPriceLabel: t('upperPriceLabel'),
    upperStateLabel: t('upperStateLabel'),
    defaultStateLabel: t('defaultStateLabel'),
    submit: t('create'),
    stateOptions,
  };

  const editLabels: RuleFormLabels = { ...formLabels, submit: t('save') };

  return (
    <PageShell title={t('title')} description={t('description')}>
      <Stack gap="md">
        {/*
          BR-018-15 — the delay disclosure lives on this, the rule-configuration
          screen, stated plainly rather than in a help page. BR-018-18/DL-018-01
          — the two other disclosures this feature's every string must respect:
          nothing below is the product's own judgement, and "compra" always
          means adding to a position already held.
        */}
        <Note>{t('delayDisclosure', { minutes: view.delayMinutes })}</Note>
        <Note>{t('notAdvice')}</Note>
        <Note>{t('addNotOpenNote')}</Note>
      </Stack>

      <Section title={t('yourRulesTitle')} description={t('yourRulesDescription')}>
        {view.watched.length === 0 ? (
          <EmptyState title={t('empty')} />
        ) : (
          <List gap="lg">
            {view.watched.map((row) => (
              <WatchedRow key={row.assetId} row={row} t={t} editLabels={editLabels} />
            ))}
          </List>
        )}
      </Section>

      <Section title={t('availableTitle')} description={t('availableDescription')}>
        {view.available.length === 0 ? (
          <EmptyState title={t('availableEmpty')} />
        ) : (
          <List gap="lg">
            {view.available.map((asset) => (
              <ListItem key={asset.assetId} separated>
                <Stack gap="sm">
                  <span className="font-medium">
                    {asset.code} — {asset.name}
                  </span>
                  <RuleForm
                    action={createRuleAction}
                    assetId={asset.assetId}
                    idPrefix={`create-${asset.assetId}`}
                    labels={formLabels}
                  />
                </Stack>
              </ListItem>
            ))}
          </List>
        )}
      </Section>

      {view.ineligible.length > 0 && (
        <Section title={t('ineligibleTitle')} description={t('ineligibleDescription')}>
          <List gap="sm">
            {view.ineligible.map((asset) => (
              <ListItem key={asset.assetId} separated>
                <Cluster justify="between" gap="sm">
                  <span>
                    {asset.code} — {asset.name}
                  </span>
                  <Text as="span" tone="muted" size="xs">
                    {t('ineligibleNoPrice')}
                  </Text>
                </Cluster>
              </ListItem>
            ))}
          </List>
        </Section>
      )}
    </PageShell>
  );
}

/**
 * BR-018-18 — every sentence below names the user's own rule ("no seu limite
 * de {stateLabel} de {threshold}"), never a recommendation. `threshold` is
 * `null` exactly when the default band matched (`evaluate.ts`'s own
 * contract), so branching on it is what lets this read as prose rather than a
 * templated fill-in-the-blank for a case that does not apply.
 */
function stateTitle(row: WatchRuleRow, t: Awaited<ReturnType<typeof getTranslations>>): string {
  if (row.evaluatedState === 'unknown') return t('stateTitleUnknown');
  const stateLabel = t(`stateLabel.${row.evaluatedState}`);
  if (row.threshold === null) return t('stateTitleDefault', { stateLabel });
  return t('stateTitleBound', { stateLabel, threshold: formatCurrency(row.threshold) });
}

function boundText(
  bound: { readonly price: MoneyValue; readonly state: OpportunityState } | null,
  t: Awaited<ReturnType<typeof getTranslations>>,
): string {
  if (bound === null) return t('noBound');
  return `${formatCurrency(bound.price)} → ${t(`stateLabel.${bound.state}`)}`;
}

function WatchedRow({
  row,
  t,
  editLabels,
}: {
  readonly row: WatchRuleRow;
  readonly t: Awaited<ReturnType<typeof getTranslations>>;
  readonly editLabels: RuleFormLabels;
}) {
  return (
    <ListItem separated>
      <Stack gap="sm">
        <Cluster justify="between" gap="sm" align="baseline">
          <Cluster gap="sm" align="baseline">
            <span className="font-medium">
              {row.code} — {row.name}
            </span>
            <StateBadge
              state={row.evaluatedState}
              label={t(`stateLabel.${row.evaluatedState}`)}
              title={stateTitle(row, t)}
            />
            {row.muted && <Badge variant="outline">{t('mutedBadge')}</Badge>}
          </Cluster>

          {/* BR-018-19: the price this state was read from, and its own
              timestamp/source alongside — never implying a live price. */}
          <Stack gap="xs" align="end">
            {row.currentPrice === null ? (
              <Text as="span" tone="muted" size="sm">
                {t('noPrice')}
              </Text>
            ) : (
              <Money value={row.currentPrice} className="text-sm font-medium" />
            )}
            {row.quotedAt !== null && (
              <Text as="span" tone="muted" size="xs">
                {formatDateTime(row.quotedAt)}
                {row.source !== null ? ` · ${row.source}` : ''}
              </Text>
            )}
          </Stack>
        </Cluster>

        <Cluster gap="lg">
          <Text as="span" size="xs" tone="muted">
            {t('columnLower')}: {boundText(row.lower, t)}
          </Text>
          <Text as="span" size="xs" tone="muted">
            {t('columnUpper')}: {boundText(row.upper, t)}
          </Text>
          <Text as="span" size="xs" tone="muted">
            {t('columnDefault')}: {t(`stateLabel.${row.defaultState}`)}
          </Text>
        </Cluster>

        <Text as="span" size="xs" tone="muted">
          {t('columnLastEmail')}:{' '}
          {row.lastEmailSentAt === null ? t('noEmailSent') : formatDateTime(row.lastEmailSentAt)}
        </Text>

        <Cluster gap="sm" align="center">
          <ActionForm action={setRuleMutedAction}>
            <input type="hidden" name="assetId" value={row.assetId} />
            <input type="hidden" name="muted" value={(!row.muted).toString()} />
            <Button type="submit" size="sm" variant="outline">
              {row.muted ? t('unmute') : t('mute')}
            </Button>
          </ActionForm>

          <details>
            <summary>
              <Text as="span" weight="medium">
                {t('edit')}
              </Text>
            </summary>
            <Stack gap="sm">
              <RuleForm
                action={updateRuleAction}
                assetId={row.assetId}
                idPrefix={`edit-${row.assetId}`}
                labels={editLabels}
                initial={{
                  lowerPrice: row.lower?.price.toString(),
                  lowerState: row.lower?.state,
                  upperPrice: row.upper?.price.toString(),
                  upperState: row.upper?.state,
                  defaultState: row.defaultState,
                }}
              />
            </Stack>
          </details>

          <ActionForm action={deleteRuleAction}>
            <input type="hidden" name="assetId" value={row.assetId} />
            <Stack gap="xs">
              <Button type="submit" variant="destructive" size="sm">
                {t('delete')}
              </Button>
            </Stack>
          </ActionForm>
        </Cluster>
        <Text as="span" size="xs" tone="muted">
          {t('deleteHint')}
        </Text>
      </Stack>
    </ListItem>
  );
}
