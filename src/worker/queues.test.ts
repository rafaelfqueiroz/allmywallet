import { describe, expect, it } from 'vitest';
import { DEAD_LETTER_QUEUE, QUEUE, QUEUE_POLICIES, type QueueName } from '@/worker/queues';

const allQueues = Object.values(QUEUE) as QueueName[];

/**
 * AR-20: retry policy, backoff and dead-lettering are configured per queue, not
 * defaulted. These assertions are about the *invariants* of that decision, not
 * about the specific numbers — a queue with no dead letter is a job that
 * vanishes, which is indistinguishable from one that never ran (BR-016-13).
 */
describe('queue policies', () => {
  it('covers every declared queue', () => {
    expect(Object.keys(QUEUE_POLICIES).sort()).toEqual([...allQueues].sort());
  });

  it('gives every queue somewhere visible to fail', () => {
    for (const queue of allQueues) {
      expect(QUEUE_POLICIES[queue].deadLetter, `${queue} has no dead letter`).toBe(
        DEAD_LETTER_QUEUE,
      );
    }
  });

  it('bounds every queue — no infinite retry, no unexpiring job', () => {
    for (const queue of allQueues) {
      const policy = QUEUE_POLICIES[queue];
      expect(policy.retryLimit, `${queue}`).toBeGreaterThan(0);
      expect(policy.expireInSeconds, `${queue}`).toBeGreaterThan(0);
    }
  });

  it('retries the quote poll least, because the free tier is a hard ceiling', () => {
    // SPEC-008: 15,000 requests/month, one ticker per call. Aggressive retrying
    // spends budget that buys nothing — the next poll 30 minutes later corrects
    // a miss anyway.
    expect(QUEUE_POLICIES[QUEUE.QUOTES_POLL].retryLimit).toBeLessThan(
      QUEUE_POLICIES[QUEUE.QUOTES_CLOSE_CAPTURE].retryLimit,
    );
  });

  it('gives the close capture the most retries, because it cannot be redone later', () => {
    // The close happens once a day. A missed close is a permanent hole in the
    // history every chart reads from.
    const retries = allQueues.map((queue) => QUEUE_POLICIES[queue].retryLimit);
    expect(QUEUE_POLICIES[QUEUE.QUOTES_CLOSE_CAPTURE].retryLimit).toBe(Math.max(...retries));
  });

  it('gives the import commit room for a 10,000-row batch', () => {
    // TESTING §8 budgets a 10k-row commit at under 60s, but the job must not
    // expire while a slow one is still legitimately running.
    expect(QUEUE_POLICIES[QUEUE.IMPORT_COMMIT].expireInSeconds).toBeGreaterThanOrEqual(3600);
  });

  it('names queues with a dotted prefix, so related work groups in the queue list', () => {
    for (const queue of allQueues) {
      expect(queue).toMatch(/^[a-z]+\.[a-z-]+$/);
    }
  });
});
