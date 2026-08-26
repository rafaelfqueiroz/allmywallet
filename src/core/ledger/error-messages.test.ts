import { describe, expect, it } from 'vitest';
import messages from '@/i18n/messages/pt-BR.json';
import { LedgerErrorCode } from '@/core/ledger/errors';
import { PositionErrorCode } from '@/core/positions/errors';
import { WalletErrorCode } from '@/core/wallets/errors';

/**
 * AR-38 / AR-44: `core/` produces stable error **codes**; the i18n layer turns
 * them into pt-BR text. That split only works if every code the domain can
 * emit actually has a message — otherwise the user sees a raw
 * `INSUFFICIENT_QUANTITY` and SPEC-006 BR-006-15's "an explanation of why, not
 * a silent rejection" quietly stops being true.
 *
 * This is the cheap mechanical gate for that, and it fails the moment someone
 * adds a code without a catalogue entry.
 */
describe('pt-BR catalogue covers every ledger and position error code', () => {
  const catalogue: Record<string, string> = messages.errors;

  it.each(Object.values(LedgerErrorCode))('has a message for %s', (code) => {
    expect(catalogue[code], `missing pt-BR message for ${code}`).toBeTypeOf('string');
    expect(catalogue[code]?.length ?? 0).toBeGreaterThan(0);
  });

  it.each(Object.values(PositionErrorCode))('has a message for %s', (code) => {
    expect(catalogue[code], `missing pt-BR message for ${code}`).toBeTypeOf('string');
  });

  /**
   * SPEC-010's codes reach the same surface: SPEC-006's bulk wallet assignment
   * (BR-006-17) is a wallets use case rendered on `/transactions`, so a
   * missing entry here shows a user the literal string
   * `ALLOCATION_EXCEEDS_HOLDINGS`. Five of the six had no message at all until
   * that surface existed to reveal it.
   */
  it.each(Object.values(WalletErrorCode))('has a message for %s', (code) => {
    expect(catalogue[code], `missing pt-BR message for ${code}`).toBeTypeOf('string');
    expect(catalogue[code]?.length ?? 0).toBeGreaterThan(0);
  });

  it('BR-006-15 — the oversell message names the held quantity, the request and the date', () => {
    // The rule is explicit that the refusal must explain itself. The context
    // the domain emits is `{ held, requested, date }` (AR-37), so the message
    // has to interpolate all three or the explanation is not actionable.
    const message = catalogue[PositionErrorCode.INSUFFICIENT_QUANTITY] ?? '';
    expect(message).toContain('{held}');
    expect(message).toContain('{requested}');
    expect(message).toContain('{date}');
  });

  it('SPEC-017 AC-4 — the 100 % refusal names the shortfall or the excess', () => {
    // "rejected at write time with the shortfall or excess named". A message
    // that said only "as metas precisam somar 100%" would leave the user to
    // add up their own form.
    const message = catalogue[WalletErrorCode.TARGETS_MUST_TOTAL_100] ?? '';
    expect(message).toContain('{total}');
    expect(message).toContain('{difference}');
  });

  it('SPEC-017 AC-12 — no error message recommends an action', () => {
    /**
     * BR-017-19 / SPEC-015 BR-015-06: the feature adds arithmetic, not
     * opinion. The human review AC-12 requires is recorded in the PR, but the
     * refusals are the strings most likely to slip — an error is where a
     * well-meaning "venda X para voltar à meta" reads as helpful.
     *
     * Scoped to SPEC-017's own codes: `INSUFFICIENT_QUANTITY` legitimately
     * says "registre a compra que está faltando", which is about the ledger
     * being incomplete rather than about a trade to place.
     */
    const advisory =
      /\b(compre|venda|vender|comprar|aporte|aportar|rebalance|rebalancear|reduza|aumente|recomend)/i;
    const spec017 = [
      WalletErrorCode.TARGETS_MUST_TOTAL_100,
      WalletErrorCode.INVALID_TARGET_PCT,
      WalletErrorCode.DUPLICATE_TARGET_ASSET,
      WalletErrorCode.TARGET_ASSET_NOT_TARGETABLE,
      WalletErrorCode.TARGET_ASSET_MISSING,
      WalletErrorCode.WALLET_HAS_NO_TARGETABLE_ASSETS,
      WalletErrorCode.TARGET_DISCARD_NOT_CONFIRMED,
    ];
    for (const code of spec017) {
      expect(advisory.test(catalogue[code] ?? ''), `${code} reads as advice`).toBe(false);
    }
  });

  it('uses no placeholder the domain does not supply', () => {
    // A placeholder with no matching context key renders as a literal
    // `{whatever}` in front of the user.
    const supplied: Record<string, readonly string[]> = {
      [PositionErrorCode.INSUFFICIENT_QUANTITY]: ['held', 'requested', 'date'],
      [PositionErrorCode.MISSING_EVENT_RATIO]: ['date'],
      [PositionErrorCode.INVALID_EVENT_RATIO]: ['ratio', 'date'],
      [LedgerErrorCode.TRANSACTION_NOT_FOUND]: ['transactionId'],
      [LedgerErrorCode.INVALID_QUANTITY]: ['type', 'quantity', 'reason'],
      [LedgerErrorCode.NEGATIVE_UNIT_PRICE]: ['unitPrice'],
      [LedgerErrorCode.NEGATIVE_FEES]: ['fees'],
      [LedgerErrorCode.RATIO_REQUIRED]: ['type'],
      [LedgerErrorCode.RATIO_NOT_APPLICABLE]: ['type', 'ratio'],
      [LedgerErrorCode.INVALID_RATIO]: ['type', 'ratio'],
      [LedgerErrorCode.FUTURE_TRADE_DATE]: ['tradeDate', 'today'],
      [LedgerErrorCode.EMPTY_SELECTION]: ['operation'],
      [LedgerErrorCode.INVALID_PAGINATION]: ['limit', 'maxLimit', 'offset'],
      [WalletErrorCode.WALLET_NOT_FOUND]: ['walletId'],
      [WalletErrorCode.INVALID_NAME]: [],
      [WalletErrorCode.INVALID_ALLOCATION_QUANTITY]: ['assetId', 'quantity'],
      [WalletErrorCode.ALLOCATION_EXCEEDS_HOLDINGS]: ['assetId', 'held', 'requested'],
      [WalletErrorCode.WALLET_ALLOCATION_INSUFFICIENT]: [
        'walletId',
        'assetId',
        'allocated',
        'requested',
      ],
      // SPEC-017. `TARGETS_MUST_TOTAL_100` is the one that has to interpolate:
      // AC-4 requires the shortfall or excess to be **named**, and the domain
      // emits it as the signed `difference` alongside the total.
      [WalletErrorCode.TARGETS_MUST_TOTAL_100]: ['total', 'difference'],
      [WalletErrorCode.INVALID_TARGET_PCT]: ['assetId', 'targetPct'],
      [WalletErrorCode.DUPLICATE_TARGET_ASSET]: ['assetId'],
      [WalletErrorCode.TARGET_ASSET_NOT_TARGETABLE]: ['walletId', 'assetId'],
      [WalletErrorCode.TARGET_ASSET_MISSING]: ['walletId', 'assetId', 'missingCount'],
      [WalletErrorCode.WALLET_HAS_NO_TARGETABLE_ASSETS]: ['walletId'],
      [WalletErrorCode.TARGET_DISCARD_NOT_CONFIRMED]: ['walletId', 'discardedCount'],
    };

    for (const [code, keys] of Object.entries(supplied)) {
      const used = [...(catalogue[code] ?? '').matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      for (const placeholder of used) {
        expect(keys, `${code} uses {${placeholder}}, which the domain never supplies`).toContain(
          placeholder,
        );
      }
    }
  });
});
