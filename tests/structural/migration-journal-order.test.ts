import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * AR-23 / AR-69 — drizzle's migrator applies a journal entry only when its
 * `when` is later than the last migration the database has already applied.
 * An entry stamped earlier is skipped **silently and forever** on every
 * database that is already migrated, while a fresh empty database applies it
 * normally — so no other test notices.
 *
 * #113: `0020`'s entry was written by hand ahead of the real clock, and
 * `pnpm db:generate` then stamped `0021` earlier than it. The personal instance
 * would have started on the new image without the new CHECK constraint.
 */
describe('migration journal', () => {
  const journal = JSON.parse(
    readFileSync(join(process.cwd(), 'src/db/migrations/meta/_journal.json'), 'utf8'),
  ) as { entries: { idx: number; tag: string; when: number }[] };

  it('orders entries by idx with strictly increasing timestamps', () => {
    const outOfOrder = journal.entries.flatMap((entry, i) => {
      const previous = journal.entries[i - 1];
      if (previous === undefined) return [];
      return entry.idx === previous.idx + 1 && entry.when > previous.when
        ? []
        : [`${previous.tag} (${previous.when}) → ${entry.tag} (${entry.when})`];
    });
    expect(outOfOrder).toEqual([]);
  });

  it('names each entry after its idx', () => {
    for (const entry of journal.entries) {
      expect(entry.tag.startsWith(String(entry.idx).padStart(4, '0'))).toBe(true);
    }
  });
});
