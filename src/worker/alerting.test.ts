import { describe, expect, it } from 'vitest';
import { describeDeadLetterFailure, isQueueBacklogWarning } from '@/worker/alerting';

describe('isQueueBacklogWarning', () => {
  it('recognises a genuine queue-backlog warning', () => {
    expect(isQueueBacklogWarning({ name: 'dead-letter', queuedCount: 120 })).toEqual({
      queue: 'dead-letter',
      queuedCount: 120,
    });
  });

  it('ignores a slow-query warning — no name/queuedCount fields', () => {
    expect(isQueueBacklogWarning({ elapsed: 4200, sql: 'select 1' })).toBeUndefined();
  });

  it('ignores a clock-skew warning', () => {
    expect(isQueueBacklogWarning({ seconds: 12, direction: 'slower' })).toBeUndefined();
  });

  it('rejects a malformed payload with the right key names but wrong types', () => {
    expect(isQueueBacklogWarning({ name: 42, queuedCount: 'many' })).toBeUndefined();
  });
});

describe('describeDeadLetterFailure', () => {
  it('names the originating queue when pg-boss recorded one', () => {
    expect(describeDeadLetterFailure({ id: 'job-1' }, { sourceName: 'quotes.poll' })).toEqual({
      jobId: 'job-1',
      originalQueue: 'quotes.poll',
    });
  });

  it('falls back to "unknown" when the source job cannot be found', () => {
    expect(describeDeadLetterFailure({ id: 'job-2' }, null)).toEqual({
      jobId: 'job-2',
      originalQueue: 'unknown',
    });
  });

  it('falls back to "unknown" when pg-boss recorded no source (a job dead-lettered manually)', () => {
    expect(describeDeadLetterFailure({ id: 'job-3' }, { sourceName: null })).toEqual({
      jobId: 'job-3',
      originalQueue: 'unknown',
    });
  });
});
