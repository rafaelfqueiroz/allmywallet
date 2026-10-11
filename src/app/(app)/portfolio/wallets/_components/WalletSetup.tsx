import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import {
  allocateAction,
  createWalletAction,
  deleteWalletAction,
  clearStandingRuleAction,
  setStandingRuleAction,
} from '@/app/(app)/wallets/actions';
import { labelFor, type loadWalletsPageData } from '@/app/(app)/wallets/data';
import { Money } from '@/app/money';
import { ActionForm } from '@/components/patterns/action-form';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { Field } from '@/components/patterns/field';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { List, ListItem } from '@/components/layout/list';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Text } from '@/components/ui/text';

// ---------------------------------------------------------------------------
// Setup, until Configurações › Carteiras (#210)
// ---------------------------------------------------------------------------

type WalletsPageData = Awaited<ReturnType<typeof loadWalletsPageData>>;

/**
 * SPEC-010 — create, assign, standing rules and delete:
 * today's `/wallets` setup, moved unchanged to Portfólio › Carteiras ›
 * Configurar so `/wallets` can redirect. #210 moves all of it to Configurações ›
 * Carteiras (BR-022-05), and this component goes with it.
 */
export async function WalletSetup({
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

  const walletOptions = walletChoices.map((wallet) => (
    <option key={wallet.id} value={wallet.id}>
      {wallet.name}
    </option>
  ));

  return (
    <>
      <Section title={t('needsAttentionTitle')} description={t('needsAttentionDescription')}>
        {/*
          SPEC-017 BR-017-17 / DL-017-08 — out-of-balance wallets land in **this**
          queue rather than a new one. SPEC-010 BR-010-12 already established
          one place to look for "is there anything for me to do?", and a second
          surface splits the answer across two screens. Each links to the
          wallet's balancing, which is this tab scoped to it.
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
                    <Cluster gap="lg" align="end">
                      <ActionForm action={allocateAction}>
                        <input type="hidden" name="assetId" value={item.assetId} />
                        <Cluster gap="sm" align="end">
                          <Field
                            id={`allocate-wallet-${item.assetId}`}
                            label={t('resolveAssign')}
                            width="md"
                          >
                            <NativeSelect name="walletId" required>
                              <option value="">{t('chooseWallet')}</option>
                              {walletOptions}
                            </NativeSelect>
                          </Field>
                          <Field
                            id={`allocate-quantity-${item.assetId}`}
                            label={t('resolveQuantity')}
                            width="sm"
                          >
                            <Input
                              name="quantity"
                              defaultValue={item.unassignedQuantity.toString()}
                            />
                          </Field>
                          <Button type="submit" size="sm">
                            {t('resolveSubmit')}
                          </Button>
                        </Cluster>
                      </ActionForm>

                      <ActionForm action={setStandingRuleAction}>
                        <input type="hidden" name="assetId" value={item.assetId} />
                        <Cluster gap="sm" align="end">
                          <Field
                            id={`standing-rule-${item.assetId}`}
                            label={t('standingRuleTitle')}
                            width="md"
                          >
                            <NativeSelect name="walletId" required>
                              <option value="">{t('chooseWallet')}</option>
                              {walletOptions}
                            </NativeSelect>
                          </Field>
                          <Button type="submit" size="sm" variant="outline">
                            {t('standingRuleSet')}
                          </Button>
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
                      <Button type="submit" size="sm" variant="outline">
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

      <Section title={t('createTitle')}>
        <ActionForm action={createWalletAction}>
          <Cluster gap="md" align="end">
            <Field id="wallet-name" label={t('nameLabel')} width="lg">
              <Input name="name" required placeholder={t('namePlaceholder')} />
            </Field>
            <Field id="wallet-description" label={t('descriptionLabel')} width="lg">
              <Input name="description" />
            </Field>
            <Field id="wallet-goal" label={t('goalLabel')} hint={t('goalHint')} width="lg">
              <Input name="goal" />
            </Field>
            <Field id="wallet-color" label={t('colorLabel')} width="xs">
              <Input name="color" type="color" />
            </Field>
            <Button type="submit">{t('create')}</Button>
          </Cluster>
        </ActionForm>
      </Section>

      <Section title={t('yourWallets')}>
        {walletChoices.length === 0 ? (
          <EmptyState title={t('empty')} />
        ) : (
          <List gap="sm">
            {walletChoices.map((wallet) => (
              <ListItem key={wallet.id} separated>
                <Cluster justify="between" gap="sm">
                  <Button asChild variant="link">
                    <Link href={`/wallets/${wallet.id}`}>{wallet.name}</Link>
                  </Button>
                  <ActionForm action={deleteWalletAction}>
                    <input type="hidden" name="walletId" value={wallet.id} />
                    <Button type="submit" variant="destructive" size="sm">
                      {t('delete')}
                    </Button>
                  </ActionForm>
                </Cluster>
              </ListItem>
            ))}
          </List>
        )}
      </Section>
    </>
  );
}
