import { describe, expect, it } from 'vitest';
import { CreateWalletSchema, UpdateWalletSchema } from '@/app/(app)/wallets/wallet-input';

/**
 * SPEC-010 BR-010-01 — "Sem cor". A native colour input always submits a value,
 * so no colour is its own field, `noColor=on`, and the boundary — not the
 * script — decides what it means, so it holds without JavaScript.
 */
describe('wallet input — Sem cor', () => {
  it('stores no colour when noColor is on, whatever colour value came with it', () => {
    const parsed = CreateWalletSchema.parse({ name: 'Reserva', color: '#336699', noColor: 'on' });
    expect(parsed.color).toBeNull();
    expect(parsed).not.toHaveProperty('noColor');
  });

  it('keeps the colour when noColor is absent — an unchecked box posts nothing', () => {
    expect(CreateWalletSchema.parse({ name: 'Reserva', color: '#336699' }).color).toBe('#336699');
  });

  it('maps an edit the same way, so a NULL colour stays NULL', () => {
    const parsed = UpdateWalletSchema.parse({
      walletId: 'w1',
      name: 'Reserva',
      color: '#000000',
      noColor: 'on',
    });
    expect(parsed.color).toBeNull();
    expect(UpdateWalletSchema.parse({ walletId: 'w1', color: '#16a34a' }).color).toBe('#16a34a');
  });

  it('refuses a noColor value that is not the checkbox’s own', () => {
    expect(CreateWalletSchema.safeParse({ name: 'x', noColor: 'yes' }).success).toBe(false);
  });

  it('still lets a blank name through, for the use case to refuse (BR-022-21)', () => {
    expect(CreateWalletSchema.safeParse({ name: '' }).success).toBe(true);
  });
});
