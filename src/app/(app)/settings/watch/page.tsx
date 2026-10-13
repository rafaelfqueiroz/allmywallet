import { getTranslations } from 'next-intl/server';
import type { OpportunityState } from '@/core/opportunity/ports';
import { tryUserId } from '@/lib/session';
import { loadWatchView } from '@/app/(app)/watch/data';
import { createRuleAction, updateRuleAction } from '@/app/(app)/watch/actions';
import { RuleForm, type RuleFormLabels } from '@/app/(app)/settings/watch/_components/RuleForm';
import {
  AvailableTable,
  IneligibleTable,
  RetainedTable,
  RULE_EDITOR_ANCHOR,
  WatchedTable,
} from '@/app/(app)/settings/watch/_components/WatchTables';
import { WatchSection } from '@/app/(app)/settings/watch/_components/WatchSection';
import { SettingsFrame } from '@/app/(app)/settings/_components/SettingsFrame';
import { PageShell } from '@/app/page-shell';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { Note } from '@/components/patterns/note';
import { QueryLink } from '@/components/patterns/query-link';
import { loadHideValues } from '@/app/hide-values';
import { saveHideValuesAction } from '@/app/(settings)/account/actions';
import { RevealValuesForm } from '@/components/patterns/reveal-values-form';
import { Stack } from '@/components/layout/stack';
import { Button } from '@/components/ui/button';

/**
 * SPEC-018 — the watch screen (BR-018-19/20), as Configurações › Observar
 * preços › **Regras** (SPEC-022 BR-022-05, #212). It was `/watch`, which
 * redirects here (BR-022-08); the e-mail cooldown that sat at its foot is the
 * section's Parâmetros tab. Lists every held, eligible
 * asset with its current price, both bounds, the evaluated state and the
 * time of the last email sent for it; offers a rule form for held eligible
 * assets with none yet; and states, for a held CDB/LCI/LCA, that it has no
 * market price to watch (BR-018-02).
 *
 * SPEC-022 BR-022-18 — each of the four lists is a table (`WatchTables`), and
 * **no form sits in a cell**: the rule form is the one editor below the notes,
 * opened by `?rule=<asset>` from a row's "Editar" or an available asset's
 * "Criar regra".
 *
 * Never statically prerendered: this renders one tenant's own holdings and
 * rules, so a cached copy built once would be served to every visitor — the
 * same tenant-isolation reasoning `(settings)/preferences/page.tsx` gives at
 * length.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function WatchPage({ searchParams }: PageProps) {
  const t = await getTranslations('watch');
  const ts = await getTranslations('settings');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell title={ts('title')}>
        <EmptyState title={t('signedOut')} />
      </PageShell>
    );
  }

  const raw = await searchParams;
  const editing = typeof raw['rule'] === 'string' ? raw['rule'] : undefined;
  const masked = await loadHideValues();
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

  // The rule the reader opened: one with a rule (edit) or one without (create).
  // An id that is neither — a rule since deleted, a stale link — opens nothing.
  const editedRule = view.watched.find((row) => row.assetId === editing);
  const newRuleFor = view.available.find((asset) => asset.assetId === editing);

  return (
    <SettingsFrame>
      <WatchSection>
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
          {/*
            BR-018-25 — opt-in is off by default, so for a new account every
            state below is in-app only. Saying which it is stops the screen from
            implying an email that will never arrive; `emailConsented` is read
            from SPEC-004's own consent record, not a feature-local copy.
          */}
          <Note>{view.emailConsented ? t('emailOn') : t('emailOff')}</Note>
        </Stack>

        {(editedRule !== undefined || newRuleFor !== undefined) && (
          <Section
            id={RULE_EDITOR_ANCHOR}
            className="scroll-mt-20"
            title={
              editedRule !== undefined
                ? t('editTitle', { asset: `${editedRule.code} — ${editedRule.name}` })
                : t('createTitle', {
                    asset: `${newRuleFor?.code ?? ''} — ${newRuleFor?.name ?? ''}`,
                  })
            }
            actions={
              <Button asChild variant="ghost" size="sm">
                <QueryLink drop={['rule']}>{t('closeEditor')}</QueryLink>
              </Button>
            }
          >
            {editedRule !== undefined ? (
              masked ? (
                // SPEC-022 BR-022-24: the thresholds would sit in the inputs.
                <RevealValuesForm action={saveHideValuesAction} />
              ) : (
                <RuleForm
                  action={updateRuleAction}
                  assetId={editedRule.assetId}
                  idPrefix={`edit-${editedRule.assetId}`}
                  labels={editLabels}
                  initial={{
                    lowerPrice: editedRule.lower?.price.toString(),
                    lowerState: editedRule.lower?.state,
                    upperPrice: editedRule.upper?.price.toString(),
                    upperState: editedRule.upper?.state,
                    defaultState: editedRule.defaultState,
                  }}
                />
              )
            ) : (
              newRuleFor !== undefined && (
                <RuleForm
                  action={createRuleAction}
                  assetId={newRuleFor.assetId}
                  idPrefix={`create-${newRuleFor.assetId}`}
                  labels={formLabels}
                />
              )
            )}
          </Section>
        )}

        <Section
          title={t('yourRulesTitle')}
          // The delete control is an icon, so what it does is said here, once.
          description={`${t('yourRulesDescription')} ${t('deleteHint')}`}
        >
          {view.watched.length === 0 ? (
            <EmptyState title={t('empty')} />
          ) : (
            <WatchedTable rows={view.watched} />
          )}
        </Section>

        {view.retained.length > 0 && (
          <Section title={t('retainedTitle')} description={t('retainedDescription')}>
            <RetainedTable rules={view.retained} />
          </Section>
        )}

        <Section title={t('availableTitle')} description={t('availableDescription')}>
          {view.available.length === 0 ? (
            <EmptyState title={t('availableEmpty')} />
          ) : (
            <AvailableTable assets={view.available} />
          )}
        </Section>

        {view.ineligible.length > 0 && (
          <Section title={t('ineligibleTitle')} description={t('ineligibleDescription')}>
            <IneligibleTable assets={view.ineligible} />
          </Section>
        )}
      </WatchSection>
    </SettingsFrame>
  );
}
