import { Decimal } from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@/db/client';
import { FakeClock } from '@/core/shared/clock';
import { AssetId, UserId } from '@/core/shared/ids';
import type { OpportunityAlert } from '@/core/opportunity/ports';
import { ResendEmailSender } from '@/adapters/email/resend-email-sender';

/**
 * SPEC-021 BR-021-34 — the transport only. What is sent, and whether, is
 * SPEC-018's and tested there (BR-021-35); this asserts the request Resend
 * receives and that a rejection is not swallowed.
 */
const userId = UserId.of('0190a000-0000-7000-8000-0000000000aa');

function databaseReturning(rows: readonly { email: string }[]): Database {
  return {
    select: () => ({ from: () => ({ where: async () => rows }) }),
  } as unknown as Database;
}

const alert = {
  assetId: AssetId.of('0190a000-0000-7000-8000-0000000000bb'),
  assetCode: 'PETR4',
  assetName: 'Petrobras PN',
  price: new Decimal('38.50'),
  quotedAt: new Date('2026-09-10T15:00:00Z'),
  source: 'brapi',
  state: 'buy',
  matched: 'lower',
  threshold: new Decimal('40.00'),
  delayMinutes: 30,
} as unknown as OpportunityAlert;

describe('ResendEmailSender', () => {
  it('posts the rendered message to the account address with the API key', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"id":"1"}', { status: 200 }));
    const sender = new ResendEmailSender(
      databaseReturning([{ email: 'owner@example.invalid' }]),
      new FakeClock('2026-09-10T15:05:00Z'),
      { apiKey: 're_test', from: 'AllMyWallet <alerts@example.invalid>' },
      fetchImpl as unknown as typeof fetch,
    );

    await sender.sendStateChange(userId, alert);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.to).toEqual(['owner@example.invalid']);
    expect(body.from).toBe('AllMyWallet <alerts@example.invalid>');
    expect(String(body.subject)).toContain('PETR4');
    expect(String(body.text)).toContain('/unsubscribe?token=');
  });

  it('throws when the provider rejects the message, without echoing its body', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('owner@example.invalid is invalid', { status: 422 }),
    );
    const sender = new ResendEmailSender(
      databaseReturning([{ email: 'owner@example.invalid' }]),
      new FakeClock('2026-09-10T15:05:00Z'),
      { apiKey: 're_test', from: 'alerts@example.invalid' },
      fetchImpl as unknown as typeof fetch,
    );

    const failure = sender.sendStateChange(userId, alert);
    await expect(failure).rejects.toThrow('HTTP 422');
    await expect(failure).rejects.not.toThrow('owner@example.invalid');
  });

  it('throws when the account no longer exists, sending nothing', async () => {
    const fetchImpl = vi.fn();
    const sender = new ResendEmailSender(
      databaseReturning([]),
      new FakeClock('2026-09-10T15:05:00Z'),
      { apiKey: 're_test', from: 'alerts@example.invalid' },
      fetchImpl as unknown as typeof fetch,
    );

    await expect(sender.sendStateChange(userId, alert)).rejects.toThrow('no longer exists');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
