import { describe, expect, it } from 'vitest';
import messages from '@/i18n/messages/pt-BR.json';
import { USER_SETTABLE_KEYS } from '@/config/registry';

/**
 * `/preferences` renders one field per user-settable key and looks its copy up
 * as `preferences.keys.<key>.label`. next-intl reads every `.` in that path as
 * nesting, so a catalogue holding `"reports.benchmarks"` as one flat key never
 * resolves: the page shows the raw message id instead. That stayed invisible
 * while no signed-in session could reach the page. BR-002-01 adds a field for
 * every new `levels: [..., 'user']` key with no other change, so this is the
 * check that the copy arrived with it.
 */
function lookup(path: readonly string[]): unknown {
  return path.reduce<unknown>(
    (node, segment) =>
      typeof node === 'object' && node !== null
        ? (node as Record<string, unknown>)[segment]
        : undefined,
    messages.preferences.keys,
  );
}

describe('preferences catalogue', () => {
  it.each(USER_SETTABLE_KEYS)('%s has a nested label and description', (key) => {
    const segments = key.split('.');
    expect(lookup([...segments, 'label'])).toEqual(expect.any(String));
    expect(lookup([...segments, 'description'])).toEqual(expect.any(String));
  });
});
