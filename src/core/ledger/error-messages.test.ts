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
