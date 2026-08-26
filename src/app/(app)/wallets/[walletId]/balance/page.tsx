import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { WalletId } from '@/core/shared/ids';
import { Quantity } from '@/core/shared/money';
import { TARGET_MODES } from '@/core/wallets/targets';
import { DriftUnavailableReason } from '@/core/wallets/drift';
import { setWalletTargetsAction } from '@/app/(app)/wallets/actions';
import { TARGET_FIELD_PREFIX } from '@/app/(app)/wallets/target-fields';
import { labelFor, resolveAssetLabels } from '@/app/(app)/wallets/data';
import { loadWalletBalance } from '@/app/(app)/wallets/balance-data';
import { tryUserId } from '@/app/(app)/wallets/session';
import { PageShell } from '@/components/patterns/page-shell';
import { ActionForm } from '@/components/patterns/action-form';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { Money } from '@/components/patterns/money';
import { formatPercentPoints } from '@/i18n/format';
import { Note } from '@/components/patterns/note';
import { Field } from '@/components/patterns/field';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Text } from '@/components/ui/text';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * SPEC-017 — one wallet's targets, the drift against them, and the distance in
 * R$ and in cotas.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCREEN IS NOT ALLOWED TO SAY.
 *
 * BR-017-19 / AC-12: no string here may recommend buying, selling, trimming or
 * rebalancing. Every figure is labelled as a **distance from the user's own
 * target** — `columnGapShares` is "Distância em cotas", never "cotas a
 * comprar" — and `noAdviceNote` states that plainly at the foot of the table
 * rather than leaving the reader to infer it. The wording is reviewed by a
 * human and recorded in the PR (AC-12); no test can decide whether a sentence
 * reads as advice.
 *
 * **There is no chart, and that is the SPEC-016 BR-016-16 answer.** Every
 * figure is text in a table, as SPEC-012's Performance report is, so there is
 * no visual-only information to provide an alternative for. A drift chart
 * would also need drift *history*, which DL-017-06 excludes precisely so that
 * nothing on this screen can be restated later (BR-017-25).
 * ---------------------------------------------------------------------------
 *
 * Never statically prerendered: this renders one tenant's own holdings and
 * intentions, so a cached copy built once would be served to every visitor.
 */
export const dynamic = 'force-dynamic';

export default async function WalletBalancePage({
  params,
}: {
  params: Promise<{ walletId: string }>;
}) {
  const { walletId: rawWalletId } = await params;
  const t = await getTranslations('balanceamento');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell width="narrow" title={t('title')}>
        <EmptyState title={t('signedOut')} />
      </PageShell>
    );
  }

  if (!/^[0-9a-f-]{36}$/i.test(rawWalletId)) notFound();
  const walletId = WalletId.of(rawWalletId);
  const balance = await loadWalletBalance(userId, walletId);
  if (balance === null) notFound();

  const labels = await resolveAssetLabels([
    ...balance.rows.map((row) => row.assetId),
    ...balance.untargeted.map((row) => row.assetId),
  ]);
  const nameOf = (assetId: (typeof balance.rows)[number]['assetId']) =>
    `${labelFor(labels, assetId).code} — ${labelFor(labels, assetId).name}`;

  return (
    <PageShell
      title={`${t('title')} · ${balance.walletName}`}
      description={t('description')}
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href={`/wallets/${balance.walletId}`}>{t('back')}</Link>
        </Button>
      }
    >
      {/*
        BR-017-11 / AC-7 — a wallet with nothing targetable in it gets an
        explanation, never an empty form. The explanation is the *reason*
        (a CDB before maturity cannot be sold, so its drift is uncorrectable),
        because "no targets here" without it reads as a missing feature.
      */}
      {!balance.hasTargetableAssets ? (
        <Section title={t('modeTitle')}>
          <EmptyState title={balance.untargeted.length === 0 ? t('empty') : t('onlyFixedIncome')} />
        </Section>
      ) : (
        <>
          {/* BR-017-10 / AC-6 — what the targets actually cover, stated. */}
          <Note>
            {balance.targetedSharePct === null
              ? t('coverageUnknown')
              : balance.untargeted.length === 0
                ? t('coverageAll')
                : // AR-09: both percentages go through the single formatter, so
                  // "60,00%" beside "40,00%" cannot disagree about precision the
                  // way a hand-written one would.
                  t('coverage', {
                    covered: formatPercentPoints(balance.targetedSharePct),
                    rest: formatPercentPoints(
                      Quantity.fromString('100').minus(balance.targetedSharePct),
                    ),
                  })}
          </Note>

          {/* BR-017-07: the wallet is asking for a decision, and says which. */}
          {balance.needsReview && (
            <Note>
              {t('needsReview', {
                total: formatPercentPoints(
                  balance.rows.reduce((sum, row) => sum.plus(row.targetPct), Quantity.zero()),
                ),
              })}
            </Note>
          )}

          {/* BR-017-21 / AC-13 — an absence, stated, rather than a computed figure. */}
          {balance.unavailableReason !== null && (
            <Note>
              {balance.unavailableReason === DriftUnavailableReason.PRICE_UNUSABLE
                ? t('unavailablePrice', {
                    assets: balance.unpricedAssetIds.map(nameOf).join(', '),
                  })
                : t('unavailableNoValue')}
            </Note>
          )}

          <Section
            title={t('tableTitle')}
            description={t('toleranceHint', {
              tolerance: formatPct(balance.tolerancePp),
            })}
          >
            <Stack gap="md">
              <Table>
                <TableCaption className="sr-only">{t('tableCaption')}</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">{t('columnAsset')}</TableHead>
                    <TableHead scope="col">{t('columnQuantity')}</TableHead>
                    <TableHead scope="col">{t('columnValue')}</TableHead>
                    <TableHead scope="col">{t('columnTarget')}</TableHead>
                    <TableHead scope="col">{t('columnCurrent')}</TableHead>
                    <TableHead scope="col">{t('columnDrift')}</TableHead>
                    <TableHead scope="col">{t('columnGapValue')}</TableHead>
                    <TableHead scope="col">{t('columnGapShares')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {balance.rows.map((row) => (
                    <TableRow key={row.assetId}>
                      <TableCell className="py-row">
                        <Stack gap="xs" align="start">
                          <span>{nameOf(row.assetId)}</span>
                          {row.outOfTolerance && (
                            <Badge variant="destructive">{t('outOfTolerance')}</Badge>
                          )}
                        </Stack>
                      </TableCell>
                      <TableCell className="py-row">
                        <Money value={row.quantity} kind="quantity" />
                      </TableCell>
                      <TableCell className="py-row">
                        <Money value={row.value} />
                      </TableCell>
                      <TableCell className="py-row">
                        <Money value={row.targetPct} kind="percentPoints" />
                      </TableCell>
                      <TableCell className="py-row">
                        {row.currentPct === null ? (
                          <Unavailable label={t('unavailable')} />
                        ) : (
                          <Money value={row.currentPct} kind="percentPoints" />
                        )}
                      </TableCell>
                      <TableCell className="py-row">
                        {row.driftPp === null ? (
                          <Unavailable label={t('unavailable')} />
                        ) : (
                          <Money value={row.driftPp} kind="percentPoints" signed />
                        )}
                      </TableCell>
                      <TableCell className="py-row">
                        {row.gap === null ? (
                          <Unavailable label={t('unavailable')} />
                        ) : (
                          <Money value={row.gap.gapValue} signed />
                        )}
                      </TableCell>
                      <TableCell className="py-row">
                        {row.gap === null || row.gap.tradableShares === null ? (
                          <Unavailable label={t('unavailable')} />
                        ) : (
                          // BR-017-20: the count is arithmetic over a delayed
                          // quote, and says so next to itself rather than in a
                          // footnote the reader has to go and find.
                          <Cluster gap="xs" align="baseline">
                            <Money value={row.gap.tradableShares} kind="quantity" signed />
                            <Text as="span" size="xs" tone="muted" title={t('approximateHint')}>
                              {t('approximate')}
                            </Text>
                          </Cluster>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {/* BR-017-19 — stated, not implied. */}
              <Note>{t('noAdviceNote')}</Note>
            </Stack>
          </Section>

          <Section title={t('targetsTitle')} description={t('modeHint')}>
            <ActionForm action={setWalletTargetsAction}>
              <input type="hidden" name="walletId" value={balance.walletId} />
              <Stack gap="md" align="start">
                <Field id="target-mode" label={t('modeLabel')} width="md">
                  <NativeSelect name="mode" defaultValue={balance.mode}>
                    {TARGET_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {t(
                          mode === 'none'
                            ? 'modeNone'
                            : mode === 'equal_weight'
                              ? 'modeEqualWeight'
                              : 'modeManual',
                        )}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>

                {/*
                  Every targetable holding gets a field, always — including in
                  equal-weight mode, where the values are what `100 / n`
                  currently derives. Switching the select to Manual then starts
                  from what is on screen rather than from an empty form, and
                  BR-017-05's "stores nothing" is unaffected: these are only
                  read when the submitted mode is manual.
                */}
                {balance.rows.map((row) => (
                  <Field
                    key={row.assetId}
                    id={`${TARGET_FIELD_PREFIX}${row.assetId}`}
                    label={t('targetPctLabel', { asset: labelFor(labels, row.assetId).code })}
                    width="xs"
                  >
                    <Input
                      name={`${TARGET_FIELD_PREFIX}${row.assetId}`}
                      inputMode="decimal"
                      defaultValue={formatPct(row.targetPct)}
                    />
                  </Field>
                ))}

                {/* BR-017-08 / AC-5 — named, and only then discarded. */}
                {balance.mode === 'manual' && (
                  <Cluster gap="sm" align="center">
                    <Checkbox id="confirm-discard" name="confirmDiscard" />
                    <Label htmlFor="confirm-discard">{t('discardConfirm')}</Label>
                    <Text as="span" size="xs" tone="muted">
                      {t('discardWarning', { count: balance.rows.length })}
                    </Text>
                  </Cluster>
                )}

                <Button type="submit">{t('save')}</Button>
              </Stack>
            </ActionForm>
          </Section>
        </>
      )}

      {/* BR-017-09/10 — the part of the wallet the targets never cover. */}
      <Section title={t('untargetedTitle')} description={t('untargetedDescription')}>
        {balance.untargeted.length === 0 ? (
          <EmptyState title={t('untargetedEmpty')} />
        ) : (
          <Table>
            <TableCaption className="sr-only">{t('untargetedTitle')}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t('columnAsset')}</TableHead>
                <TableHead scope="col">{t('columnQuantity')}</TableHead>
                <TableHead scope="col">{t('columnValue')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {balance.untargeted.map((row) => (
                <TableRow key={row.assetId}>
                  <TableCell className="py-row">{nameOf(row.assetId)}</TableCell>
                  <TableCell className="py-row">
                    <Money value={row.quantity} kind="quantity" />
                  </TableCell>
                  <TableCell className="py-row">
                    <Money value={row.value} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </PageShell>
  );
}

/** An em dash reads as "nothing here"; this has to read as "we will not say" (BR-017-21). */
function Unavailable({ label }: { label: string }) {
  return (
    <Text as="span" size="xs" tone="muted">
      {label}
    </Text>
  );
}

/**
 * The target editor's fields are text inputs, so their default values have to
 * be strings — the one place a percentage is written by hand rather than by
 * `Money`. Two decimal places, matching what the formatter renders beside it.
 */
function formatPct(value: Quantity): string {
  return value.toDecimal().toFixed(2);
}
