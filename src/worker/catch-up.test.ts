import { describe, expect, it } from 'vitest';
import { runMarketSeriesSyncs } from '@/worker/catch-up';

/**
 * #123, BR-008-27: catch-up runs outside pg-boss, so a sync that fails there
 * is retried only if catch-up reports it — and one failing must not stop the
 * other from running.
 */
describe('runMarketSeriesSyncs', () => {
  it('runs both syncs, BCB first, and reports none when both succeed', async () => {
    const ran: string[] = [];
    const failed = await runMarketSeriesSyncs({
      'bcb.sync': async () => {
        ran.push('bcb.sync');
      },
      'tesouro.sync': async () => {
        ran.push('tesouro.sync');
      },
    });
    expect(ran).toEqual(['bcb.sync', 'tesouro.sync']);
    expect(failed).toEqual([]);
  });

  it('a failed BCB sync is reported, and does not cost Tesouro its run', async () => {
    let tesouroRan = false;
    const failed = await runMarketSeriesSyncs({
      'bcb.sync': async () => {
        throw new Error('bcb.sync: CDI did not complete; the queue retries it');
      },
      'tesouro.sync': async () => {
        tesouroRan = true;
      },
    });
    expect(tesouroRan).toBe(true);
    expect(failed).toEqual(['bcb.sync']);
  });

  it('reports every sync that failed', async () => {
    const failing = async () => {
      throw new Error('down');
    };
    const failed = await runMarketSeriesSyncs({ 'bcb.sync': failing, 'tesouro.sync': failing });
    expect(failed).toEqual(['bcb.sync', 'tesouro.sync']);
  });
});
