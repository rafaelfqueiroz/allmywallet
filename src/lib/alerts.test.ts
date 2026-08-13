import { describe, expect, it, vi, beforeEach } from 'vitest';
import { logger } from '@/lib/logger';
import { raiseAlert } from '@/lib/alerts';

// ESM module namespaces are not configurable, so `@sentry/nextjs`'s
// `captureMessage` cannot be `vi.spyOn`'d directly — it must be mocked at the
// module level instead (vitest hoists this above the imports below).
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn(() => 'event-id') }));

/**
 * SPEC-016 BR-016-13: "each alert in BR-016-13 fires in a simulated failure
 * and reaches an operator." `raiseAlert` is the one function every alert site
 * in the worker (src/worker/index.ts) funnels through, so proving it reaches
 * both configured surfaces (the structured log and Sentry) here is what makes
 * that acceptance criterion checkable without a live Sentry project.
 */
describe('raiseAlert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs a structured error line naming the alert kind and context', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);

    raiseAlert('queue_backlog', { queue: 'dead-letter', queuedCount: 120, threshold: 50 });

    const [payload, message] = errorSpy.mock.calls[0] ?? [];
    expect(message).toContain('queue_backlog');
    expect(payload).toMatchObject({
      alertKind: 'queue_backlog',
      queue: 'dead-letter',
      queuedCount: 120,
      threshold: 50,
    });
    errorSpy.mockRestore();
  });

  it('reaches Sentry at error level, tagged with the alert kind', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const Sentry = await import('@sentry/nextjs');

    raiseAlert('job_failed', { jobId: 'job-1', originalQueue: 'quotes.poll' });

    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'operational alert: job_failed',
      expect.objectContaining({
        level: 'error',
        tags: { alertKind: 'job_failed' },
        extra: { jobId: 'job-1', originalQueue: 'quotes.poll' },
      }),
    );
    vi.restoreAllMocks();
  });

  it('defaults context to an empty object', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);

    expect(() => raiseAlert('error_rate')).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ alertKind: 'error_rate' }),
      expect.any(String),
    );
    vi.restoreAllMocks();
  });
});
