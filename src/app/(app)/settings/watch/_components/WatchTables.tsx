import { Bell, BellOff, Pencil, Trash2 } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import type { Money as MoneyValue } from '@/core/shared/money';
import type { OpportunityState } from '@/core/opportunity/ports';
import { currencyText, formatDateTime } from '@/i18n/format';
import type {
  WatchAvailableAsset,
  WatchIneligibleAsset,
  WatchRetainedRule,
  WatchRuleRow,
} from '@/app/(app)/watch/data';
import { deleteRuleAction, setRuleMutedAction } from '@/app/(app)/watch/actions';
import { ranksOf, rankKeys } from '@/app/(app)/portfolio/_components/ranks';
import { watchRuleAnchor } from '@/lib/watch-paths';
import { ActionForm } from '@/components/patterns/action-form';
import { NodeTable, type NodeColumn, type NodeRow } from '@/components/patterns/node-table';
import { QueryLink } from '@/components/patterns/query-link';
import { StateBadge } from '@/components/patterns/state-badge';
import { Money } from '@/app/money';
import { useHideValues } from '@/app/hide-values';
import { Cluster } from '@/components/layout/cluster';
import { Stack } from '@/components/layout/stack';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/**
 * SPEC-022 BR-022-18 — the four lists on Configurações › Observar preços ›
 * Regras, as tables. Each grows with the portfolio, so each is a paged,
 * filterable `DataTable` (through `NodeTable`) with a `paramPrefix` of its own.
 *
 * ---------------------------------------------------------------------------
 * NO FORM SITS IN A CELL.
 *
 * `DataTable` renders every cell twice (DS-28), so a form in a cell would post
 * its fields twice and repeat its ids. A rule's controls are therefore:
 *
 *  - **Silenciar / Excluir** — icon buttons that name a one-field form
 *    *outside* the table through their `form` attribute (`RowForms`, rendered
 *    under the table);
 *  - **Editar / Criar regra** — a link to `?rule=<asset>`, which opens the one
 *    rule editor above the tables (`page.tsx`). A rule's form is five fields;
 *    it is not a cell's content.
 *
 * **Deep links** (SPEC-022 BR-022-07): a rule's row carries `id=regra-<asset>`
 * (`rowAnchor`). The Painel's "Ver regra" and the opportunity e-mail link to
 * it with the anchor alone, and the table pages to the row, scrolls to it and
 * marks it — a rule on page 3 is where the link must land.
 * ---------------------------------------------------------------------------
 *
 * Every cell is rendered here, on the server: money through `Money` (masking,
 * BR-022-24; no money crosses as a number), sort keys as strings, epoch
 * milliseconds and **ranks** from exact `Money.comparedTo`.
 */

type Translate = Awaited<ReturnType<typeof getTranslations>>;

/** The id of the one rule editor, which "Editar" and "Criar regra" scroll to. */
export const RULE_EDITOR_ANCHOR = 'regra-editor';

/** BR-018-18 — a bound reads as the user's own: "R$ 30,00 → compra". */
function boundText(
  bound: { readonly price: MoneyValue; readonly state: OpportunityState } | null,
  t: Translate,
): React.ReactNode {
  if (bound === null) return t('noBound');
  // `Money`, so the threshold masks with every other amount (BR-022-24).
  return (
    <>
      <Money value={bound.price} /> → {t(`stateLabel.${bound.state}`)}
    </>
  );
}

/** The two bounds and the band between them, one per line. */
function Limits({
  lower,
  upper,
  defaultState,
  t,
}: {
  readonly lower: { readonly price: MoneyValue; readonly state: OpportunityState } | null;
  readonly upper: { readonly price: MoneyValue; readonly state: OpportunityState } | null;
  readonly defaultState: OpportunityState;
  readonly t: Translate;
}) {
  return (
    <Stack gap="xs" className="whitespace-normal">
      <Text as="span" size="xs" tone="muted">
        {t('columnLower')}: {boundText(lower, t)}
      </Text>
      <Text as="span" size="xs" tone="muted">
        {t('columnUpper')}: {boundText(upper, t)}
      </Text>
      <Text as="span" size="xs" tone="muted">
        {t('columnDefault')}: {t(`stateLabel.${defaultState}`)}
      </Text>
    </Stack>
  );
}

/**
 * BR-018-18 — every sentence names the user's own rule ("no seu limite de
 * {stateLabel} de {threshold}"), never a recommendation. `threshold` is `null`
 * exactly when the default band matched (`evaluate.ts`'s own contract).
 */
function stateTitle(row: WatchRuleRow, t: Translate, masked: boolean): string {
  if (row.evaluatedState === 'unknown') return t('stateTitleUnknown');
  const stateLabel = t(`stateLabel.${row.evaluatedState}`);
  if (row.threshold === null) return t('stateTitleDefault', { stateLabel });
  // SPEC-022 BR-022-24: a `title` is a string, so the placeholder is too.
  return t('stateTitleBound', { stateLabel, threshold: currencyText(masked)(row.threshold) });
}

/** One-field forms outside the table, named by the rows' buttons through `form`. */
function RowForms({
  assetIds,
  action,
  prefix,
  extra,
}: {
  readonly assetIds: readonly string[];
  readonly action: Parameters<typeof ActionForm>[0]['action'];
  readonly prefix: string;
  /** A second hidden field per form, by asset id. */
  readonly extra?: (assetId: string) => { readonly name: string; readonly value: string };
}) {
  return (
    <>
      {assetIds.map((assetId) => {
        const field = extra?.(assetId);
        return (
          <ActionForm key={assetId} id={`${prefix}-${assetId}`} action={action}>
            <input type="hidden" name="assetId" value={assetId} />
            {field && <input type="hidden" name={field.name} value={field.value} />}
          </ActionForm>
        );
      })}
    </>
  );
}

const MUTE_FORM = 'mute-rule';
const DELETE_FORM = 'delete-rule';

/** "Suas regras": every held, eligible asset with a rule. */
export async function WatchedTable({ rows }: { readonly rows: readonly WatchRuleRow[] }) {
  const t = await getTranslations('watch');
  const masked = useHideValues();

  const ranks = { price: ranksOf(rows, (row) => row.currentPrice) };

  const columns: NodeColumn[] = [
    { id: 'asset', header: t('columnAsset'), kind: 'text', width: 20, sortable: true },
    { id: 'state', header: t('columnState'), kind: 'control', width: 14, sortable: true },
    // A price needs far fewer digits than the largest amount the default sizes for.
    { id: 'price', header: t('columnPrice'), kind: 'money', width: 15, sortable: true },
    { id: 'limits', header: t('columnLimits'), kind: 'control', width: 26 },
    { id: 'lastEmail', header: t('columnEmail'), kind: 'control', width: 17, sortable: true },
    {
      id: 'actions',
      header: t('columnActions'),
      kind: 'control',
      width: '7rem',
      srOnlyHeader: true,
    },
  ];

  const nodes: NodeRow[] = rows.map((row, index) => {
    const asset = `${row.code} — ${row.name}`;
    const stateLabel = t(`stateLabel.${row.evaluatedState}`);
    const code = row.code;
    return {
      id: row.assetId,
      // SPEC-022 BR-022-07 — the target of the Painel's "Ver regra" and of the
      // opportunity e-mail's link, so the rule it names is marked on arrival.
      anchor: watchRuleAnchor(row.assetId),
      keys: {
        asset,
        state: stateLabel,
        lastEmail: row.lastEmailSentAt?.getTime() ?? undefined,
        ...rankKeys(ranks, index),
      },
      cells: {
        asset: <span className="font-medium">{asset}</span>,
        state: (
          <Cluster gap="xs" align="baseline" className="whitespace-normal">
            <StateBadge
              state={row.evaluatedState}
              label={stateLabel}
              title={stateTitle(row, t, masked)}
            />
            {row.muted && <Badge variant="outline">{t('mutedBadge')}</Badge>}
          </Cluster>
        ),
        // BR-018-19: the price this state was read from, and its own
        // timestamp/source alongside — never implying a live price.
        price: (
          <Stack gap="xs" align="end" className="whitespace-normal">
            {row.currentPrice === null ? (
              <Text as="span" tone="muted" size="sm">
                {t('noPrice')}
              </Text>
            ) : (
              <Money value={row.currentPrice} className="text-sm font-medium" />
            )}
            {row.quotedAt !== null && (
              <Text as="span" tone="muted" size="xs" className="text-right">
                {formatDateTime(row.quotedAt)}
                {row.source !== null ? ` · ${row.source}` : ''}
              </Text>
            )}
          </Stack>
        ),
        limits: (
          <Limits lower={row.lower} upper={row.upper} defaultState={row.defaultState} t={t} />
        ),
        lastEmail: (
          <span className="whitespace-normal">
            {row.lastEmailSentAt === null ? t('noEmailSent') : formatDateTime(row.lastEmailSentAt)}
          </span>
        ),
        actions: (
          // Icon buttons, as the ledger's row actions: the accessible name names
          // the asset, and `title` shows it on hover.
          <Cluster gap="xs" className="flex-nowrap">
            <Button
              type="submit"
              form={`${MUTE_FORM}-${row.assetId}`}
              variant="ghost"
              size="icon-sm"
              aria-label={t(row.muted ? 'unmuteFor' : 'muteFor', { asset: code })}
              title={t(row.muted ? 'unmute' : 'mute')}
            >
              {row.muted ? <Bell aria-hidden="true" /> : <BellOff aria-hidden="true" />}
            </Button>
            <Button asChild variant="ghost" size="icon-sm">
              <QueryLink
                set={{ rule: row.assetId }}
                hash={RULE_EDITOR_ANCHOR}
                aria-label={t('editFor', { asset: code })}
                title={t('edit')}
              >
                <Pencil aria-hidden="true" />
              </QueryLink>
            </Button>
            <Button
              type="submit"
              form={`${DELETE_FORM}-${row.assetId}`}
              variant="ghost"
              size="icon-sm"
              aria-label={t('deleteFor', { asset: code })}
              title={t('delete')}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </Cluster>
        ),
      },
    };
  });

  return (
    <Stack gap="sm">
      <NodeTable
        columns={columns}
        rows={nodes}
        caption={t('rulesCaption')}
        noun={t('ruleNoun')}
        filterPlaceholder={t('filterPlaceholder')}
        paramPrefix="rules"
        sort={{ id: 'asset', desc: false }}
      />
      <RowForms
        assetIds={rows.map((row) => row.assetId)}
        action={setRuleMutedAction}
        prefix={MUTE_FORM}
        extra={(assetId) => ({
          name: 'muted',
          // The toggle: the form sets the rule to the state it is not in.
          value: (!(rows.find((row) => row.assetId === assetId)?.muted ?? false)).toString(),
        })}
      />
      <RowForms
        assetIds={rows.map((row) => row.assetId)}
        action={deleteRuleAction}
        prefix={DELETE_FORM}
      />
      <Text as="span" size="xs" tone="muted">
        {t('deleteHint')}
      </Text>
    </Stack>
  );
}

/** "Regras guardadas": a rule on an asset no longer held — paused, not deleted. */
export async function RetainedTable({ rules }: { readonly rules: readonly WatchRetainedRule[] }) {
  const t = await getTranslations('watch');

  const columns: NodeColumn[] = [
    { id: 'asset', header: t('columnAsset'), kind: 'text', width: 24, sortable: true },
    { id: 'status', header: t('columnState'), kind: 'control', width: 12 },
    { id: 'limits', header: t('columnLimits'), kind: 'control', width: 30 },
    {
      id: 'actions',
      header: t('columnActions'),
      kind: 'control',
      width: '4rem',
      srOnlyHeader: true,
    },
  ];

  const nodes: NodeRow[] = rules.map((rule) => {
    const asset = `${rule.code} — ${rule.name}`;
    return {
      id: rule.assetId,
      // A retained rule keeps its anchor: an e-mail sent before the sale still
      // links here (BR-018-03).
      anchor: watchRuleAnchor(rule.assetId),
      keys: { asset },
      cells: {
        asset: <span className="font-medium">{asset}</span>,
        status: <Badge variant="secondary">{t('retainedBadge')}</Badge>,
        limits: (
          <Limits lower={rule.lower} upper={rule.upper} defaultState={rule.defaultState} t={t} />
        ),
        /*
          The only affordance a paused rule needs. Editing thresholds on an
          asset the user no longer holds would be editing a rule against a
          position that does not exist; deleting it is what BR-018-03's "not
          silently deleted by a sale" leaves to the person who wrote it.
        */
        actions: (
          <Button
            type="submit"
            form={`${DELETE_FORM}-${rule.assetId}`}
            variant="ghost"
            size="icon-sm"
            aria-label={t('deleteFor', { asset: rule.code })}
            title={t('delete')}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        ),
      },
    };
  });

  return (
    <Stack gap="sm">
      <NodeTable
        columns={columns}
        rows={nodes}
        caption={t('retainedCaption')}
        noun={t('ruleNoun')}
        filterPlaceholder={t('filterPlaceholder')}
        paramPrefix="retained"
        sort={{ id: 'asset', desc: false }}
      />
      <RowForms
        assetIds={rules.map((rule) => rule.assetId)}
        action={deleteRuleAction}
        prefix={DELETE_FORM}
      />
    </Stack>
  );
}

/** "Ativos que você pode observar": held and eligible, with no rule yet. */
export async function AvailableTable({
  assets,
}: {
  readonly assets: readonly WatchAvailableAsset[];
}) {
  const t = await getTranslations('watch');

  const nodes: NodeRow[] = assets.map((asset) => {
    const name = `${asset.code} — ${asset.name}`;
    return {
      id: asset.assetId,
      keys: { asset: name },
      cells: {
        asset: <span className="font-medium">{name}</span>,
        actions: (
          <Button asChild variant="outline" size="sm">
            <QueryLink
              set={{ rule: asset.assetId }}
              hash={RULE_EDITOR_ANCHOR}
              aria-label={t('createFor', { asset: asset.code })}
            >
              {t('create')}
            </QueryLink>
          </Button>
        ),
      },
    };
  });

  return (
    <NodeTable
      columns={[
        { id: 'asset', header: t('columnAsset'), kind: 'text', width: 40, sortable: true },
        {
          id: 'actions',
          header: t('columnActions'),
          kind: 'control',
          width: '9rem',
          srOnlyHeader: true,
        },
      ]}
      rows={nodes}
      caption={t('availableTitle')}
      noun={t('assetNoun')}
      filterPlaceholder={t('filterPlaceholder')}
      paramPrefix="available"
      sort={{ id: 'asset', desc: false }}
    />
  );
}

/** "Sem preço de mercado": CDB, LCI and LCA, which can carry no rule (BR-018-02). */
export async function IneligibleTable({
  assets,
}: {
  readonly assets: readonly WatchIneligibleAsset[];
}) {
  const t = await getTranslations('watch');

  const nodes: NodeRow[] = assets.map((asset) => {
    const name = `${asset.code} — ${asset.name}`;
    const reason = t('ineligibleNoPrice');
    return {
      id: asset.assetId,
      keys: { asset: name, reason },
      cells: { asset: name, reason },
    };
  });

  return (
    <NodeTable
      columns={[
        { id: 'asset', header: t('columnAsset'), kind: 'text', width: 30, sortable: true },
        { id: 'reason', header: t('columnReason'), kind: 'text', width: 50 },
      ]}
      rows={nodes}
      caption={t('ineligibleTitle')}
      noun={t('assetNoun')}
      filterPlaceholder={t('filterPlaceholder')}
      paramPrefix="ineligible"
      sort={{ id: 'asset', desc: false }}
    />
  );
}
