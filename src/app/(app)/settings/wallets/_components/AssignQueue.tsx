import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import {
  allocateAction,
  clearStandingRuleAction,
  setStandingRuleAction,
} from '@/app/(app)/wallets/actions';
import { labelFor, type loadWalletsPageData } from '@/app/(app)/wallets/data';
import { AllocateForm } from '@/app/(app)/settings/wallets/_components/AllocateForm';
import { Money } from '@/app/money';
import { ActionForm } from '@/components/patterns/action-form';
import { EmptyState } from '@/components/patterns/empty-state';
import { Field, FieldAction } from '@/components/patterns/field';
import { Section } from '@/components/patterns/section';
import { Cluster } from '@/components/layout/cluster';
import { List, ListItem } from '@/components/layout/list';
import { Stack } from '@/components/layout/stack';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { Text } from '@/components/ui/text';

type WalletsPageData = Awaited<ReturnType<typeof loadWalletsPageData>>;

/**
 * SPEC-010 BR-010-12/13/14 — Configurações › Carteiras › **Atribuir ativos**:
 * the "Precisa de atenção" queue with its resolve forms, and the standing rules
 * with the way to remove each. This is where the Painel's "Distribuir" items
 * land (SPEC-020 BR-020-18).
 *
 * It lists **names, links and allocated quantities** — setup data. The
 * out-of-balance wallets (SPEC-017 BR-017-17) are here as a name and a link to
 * their balancing in Portfólio; the figures that make them out of balance are
 * there, not here (BR-022-05).
 */
export async function AssignQueue({
  walletChoices,
  pending,
  standingRules,
  unbalanced,
  labels,
}: {
  readonly walletChoices: readonly { readonly id: string; readonly name: string }[];
  readonly pending: WalletsPageData['pending'];
  readonly standingRules: WalletsPageData['standingRules'];
  readonly unbalanced: WalletsPageData['unbalanced'];
  readonly labels: WalletsPageData['labels'];
}) {
  const t = await getTranslations('wallets');

  const walletOptions = walletChoices.map((wallet) => ({ value: wallet.id, label: wallet.name }));

  return (
    <>
      <Section title={t('needsAttentionTitle')} description={t('needsAttentionDescription')}>
        {/*
          SPEC-017 BR-017-17 / DL-017-08 — out-of-balance wallets land in **this**
          queue rather than a new one. SPEC-010 BR-010-12 already established
          one place to look for "is there anything for me to do?", and a second
          surface splits the answer across two screens. Each links to the
          wallet's balancing in Portfólio.
        */}
        {unbalanced.length > 0 && (
          <List gap="sm">
            {unbalanced.map((balance) => (
              <ListItem key={balance.walletId} separated>
                <Cluster justify="between" gap="sm" align="baseline">
                  <Text as="span" size="sm">
                    {balance.outOfBalance
                      ? t('needsAttentionOutOfBalance', { wallet: balance.walletName })
                      : t('needsAttentionNeedsReview', { wallet: balance.walletName })}
                  </Text>
                  <Button asChild variant="link" size="sm">
                    <Link href={`/portfolio/wallets?wallet=${balance.walletId}`}>
                      {t('needsAttentionBalanceOpen')}
                    </Link>
                  </Button>
                </Cluster>
              </ListItem>
            ))}
          </List>
        )}

        {pending.length === 0 ? (
          unbalanced.length === 0 && <EmptyState title={t('needsAttentionEmpty')} />
        ) : (
          <List gap="lg">
            {pending.map((item) => {
              const label = labelFor(labels, item.assetId);
              return (
                <ListItem key={item.assetId} separated>
                  <Stack gap="sm">
                    <Cluster justify="between" gap="sm">
                      <span className="font-medium">
                        {label.code} — {label.name}
                      </span>
                      <Money value={item.unassignedQuantity} kind="quantity" />
                    </Cluster>
                    <Text as="span" size="xs" tone="muted">
                      {t(item.reason === 'no_wallet' ? 'reasonNoWallet' : 'reasonAmbiguousSplit')}
                    </Text>
                    <Cluster gap="lg" align="start">
                      {/* BR-010-13: one action, quantity pre-filled with the unassigned remainder. */}
                      <AllocateForm
                        action={allocateAction}
                        idPrefix={`allocate-${item.assetId}`}
                        fixed={{ name: 'assetId', value: item.assetId }}
                        choice={{
                          name: 'walletId',
                          label: t('resolveAssign'),
                          placeholder: t('chooseWallet'),
                          options: walletOptions,
                        }}
                        defaultQuantity={item.unassignedQuantity.toString()}
                        submitLabel={t('resolveSubmit')}
                      />

                      {/* BR-010-14: the escape hatch — a standing rule for this asset. */}
                      <ActionForm action={setStandingRuleAction}>
                        <input type="hidden" name="assetId" value={item.assetId} />
                        <Cluster gap="sm" align="start">
                          <Field
                            id={`standing-rule-${item.assetId}`}
                            label={t('standingRuleTitle')}
                            width="md"
                          >
                            <NativeSelect name="walletId" required>
                              <option value="">{t('chooseWallet')}</option>
                              {walletOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </NativeSelect>
                          </Field>
                          <FieldAction>
                            <Button type="submit" variant="outline">
                              {t('standingRuleSet')}
                            </Button>
                          </FieldAction>
                        </Cluster>
                      </ActionForm>
                    </Cluster>
                  </Stack>
                </ListItem>
              );
            })}
          </List>
        )}
      </Section>

      {/*
        BR-010-14 / #61 — the rules, visible and revocable. Rendered only when
        there is at least one: an empty section explaining a feature nobody has
        used is noise on the screen whose job is the queue above.
      */}
      {standingRules.length > 0 && (
        <Section title={t('standingRuleTitle')} description={t('standingRuleDescription')}>
          <List gap="sm">
            {standingRules.map((rule) => {
              const label = labelFor(labels, rule.assetId);
              const wallet = walletChoices.find((choice) => choice.id === rule.walletId);
              return (
                <ListItem key={rule.assetId} separated>
                  <Cluster justify="between" gap="sm" align="baseline">
                    <span>
                      <span className="font-medium">
                        {label.code} — {label.name}
                      </span>{' '}
                      · {t('standingRuleCurrent')}:{' '}
                      {/*
                        A deleted wallet takes its rules with it (BR-010-07), so
                        this fallback should be unreachable — rendering the id
                        rather than crashing keeps a stale row revocable.
                      */}
                      {wallet?.name ?? rule.walletId}
                    </span>
                    <ActionForm action={clearStandingRuleAction}>
                      <input type="hidden" name="assetId" value={rule.assetId} />
                      <Button
                        type="submit"
                        size="sm"
                        variant="outline"
                        aria-label={t('standingRuleClearFor', { asset: label.code })}
                      >
                        {t('standingRuleClear')}
                      </Button>
                    </ActionForm>
                  </Cluster>
                </ListItem>
              );
            })}
          </List>
        </Section>
      )}
    </>
  );
}
