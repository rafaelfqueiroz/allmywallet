import { describe, expect, it, vi } from 'vitest';
import { logger } from '@/lib/logger';
import { UserId } from '@/core/shared/ids';
import { assertNoTenantOverride, logSecurityEvent } from './security-events';

describe('logSecurityEvent', () => {
  it('never lets a raw id reach the log line, only its hash (AR-49)', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const sessionUserId = UserId.generate();

    logSecurityEvent({
      type: 'oauth_state_mismatch',
      sessionUserId,
      route: '/api/auth/callback/google',
    });

    const [payload] = warnSpy.mock.calls[0] ?? [];
    expect(JSON.stringify(payload)).not.toContain(sessionUserId);
    expect(payload).toMatchObject({ securityEventType: 'oauth_state_mismatch' });
    warnSpy.mockRestore();
  });

  it('merges optional context onto the log payload when supplied', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);

    logSecurityEvent({
      type: 'auth_rate_limit_exceeded',
      route: '/api/auth/callback/google',
      context: { attempt: 3 },
    });

    const [payload] = warnSpy.mock.calls[0] ?? [];
    expect(payload).toMatchObject({ securityEventType: 'auth_rate_limit_exceeded', attempt: 3 });
    warnSpy.mockRestore();
  });
});

/**
 * SPEC-003 BR-003-05 / TS-17: "a request supplying another tenant's user_id
 * returns the caller's own data and emits a security event." The "returns
 * the caller's own data" half is structural — `requireUserId()`
 * (src/lib/session.ts) never reads anything but the session, so there is
 * nothing here that *could* return a foreign tenant's data. This test covers
 * the other half: the event.
 */
describe('assertNoTenantOverride (SPEC-003 BR-003-05, TS-17)', () => {
  it('logs a security event when the request claims a different tenant', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const sessionUserId = UserId.generate();
    const foreignId = UserId.generate();

    assertNoTenantOverride(foreignId, sessionUserId, '/api/example');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [payload, message] = warnSpy.mock.calls[0] ?? [];
    expect(message).toContain('tenant_id_tamper_attempt');
    expect(payload).toMatchObject({
      securityEventType: 'tenant_id_tamper_attempt',
      route: '/api/example',
    });
    expect(JSON.stringify(payload)).not.toContain(sessionUserId);
    expect(JSON.stringify(payload)).not.toContain(foreignId);

    warnSpy.mockRestore();
  });

  it('does not log when no claimed id was supplied', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    assertNoTenantOverride(undefined, UserId.generate(), '/api/example');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not log when the claimed id matches the session (no tampering)', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const sessionUserId = UserId.generate();
    assertNoTenantOverride(sessionUserId, sessionUserId, '/api/example');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
