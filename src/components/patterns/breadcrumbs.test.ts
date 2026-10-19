import { describe, expect, it } from 'vitest';
import messages from '@/i18n/messages/pt-BR.json';
import { breadcrumbFor, PAGES_OUTSIDE_DESTINATIONS } from '@/components/patterns/breadcrumbs';
import { DESTINATION_TABS } from '@/components/patterns/destination-tabs';

/** A crumb trail as the reader sees it: `[label, href]`, in pt-BR. */
function trail(pathname: string, query = ''): [string, string][] {
  return breadcrumbFor(pathname, new URLSearchParams(query)).map((crumb) => [
    message(crumb.labelKey),
    crumb.href,
  ]);
}

function message(key: string): string {
  const value: unknown = key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[part] : null,
      messages,
    );
  if (typeof value !== 'string') throw new Error(`no message ${key}`);
  return value;
}

describe('breadcrumbFor — SPEC-022 BR-022-09 (amended, DL-022-27)', () => {
  it('names a destination with one task by the destination alone', () => {
    expect(trail('/dashboard')).toEqual([['Dashboard', '/dashboard']]);
    expect(trail('/transactions')).toEqual([['Transações', '/transactions']]);
  });

  it('names the tab after the destination, the root tab included', () => {
    expect(trail('/portfolio')).toEqual([
      ['Portfólio', '/portfolio'],
      ['Patrimônio', '/portfolio'],
    ]);
    expect(trail('/portfolio/composition')).toEqual([
      ['Portfólio', '/portfolio'],
      ['Composição', '/portfolio/composition'],
    ]);
    expect(trail('/reports/earnings')).toEqual([
      ['Relatórios', '/reports'],
      ['Proventos', '/reports/earnings'],
    ]);
  });

  it('names Configurações’ section and then its task', () => {
    expect(trail('/settings/wallets')).toEqual([
      ['Configurações', '/settings'],
      ['Carteiras', '/settings/wallets'],
      ['Minhas carteiras', '/settings/wallets'],
    ]);
    expect(trail('/settings/import/history')).toEqual([
      ['Configurações', '/settings'],
      ['Importar', '/settings/import'],
      ['Histórico', '/settings/import/history'],
    ]);
    expect(trail('/settings/watch/parameters')).toEqual([
      ['Configurações', '/settings'],
      ['Observar preços', '/settings/watch'],
      ['Parâmetros', '/settings/watch/parameters'],
    ]);
  });

  // DL-022-27 — a page that is not a task ends at the task it belongs to.
  it('ends a page that is not a task at its task', () => {
    const mine = [
      ['Configurações', '/settings'],
      ['Carteiras', '/settings/wallets'],
      ['Minhas carteiras', '/settings/wallets'],
    ];
    expect(trail('/settings/wallets/new')).toEqual(mine);
    expect(trail('/settings/wallets/0b9e6f0e-7f1a-4c55-9d43-0f0c1c1a2b3c')).toEqual(mine);
    expect(trail('/settings/import/0b9e6f0e-7f1a-4c55-9d43-0f0c1c1a2b3c').at(-1)).toEqual([
      'Histórico',
      '/settings/import/history',
    ]);
    expect(trail('/transactions/new')).toEqual([['Transações', '/transactions']]);
  });

  it('ends at the section where a section has no task for the page', () => {
    expect(trail('/settings/watch/somewhere')).toEqual([
      ['Configurações', '/settings'],
      ['Observar preços', '/settings/watch'],
    ]);
    expect(trail('/settings')).toEqual([['Configurações', '/settings']]);
  });

  it('names a page under no destination by itself', () => {
    expect(trail('/preferences')).toEqual([['Preferências', '/preferences']]);
    expect(trail('/fixed-income/0b9e6f0e')).toEqual([
      ['Informar taxa contratada', '/fixed-income'],
    ]);
  });

  it('has nothing to say about a page the frame does not know', () => {
    expect(trail('/primitives')).toEqual([]);
    // DS-27's boundary: a shared prefix is not a section.
    expect(trail('/transactions-outro')).toEqual([]);
  });

  // BR-022-17 — the first crumb links where the sidebar item does.
  it('carries the wallet scope on the destination crumb, as the sidebar does', () => {
    expect(trail('/portfolio/composition', 'wallet=abc&grouping=sector')[0]).toEqual([
      'Portfólio',
      '/portfolio?wallet=abc',
    ]);
    expect(trail('/transactions', 'wallet=abc')[0]).toEqual(['Transações', '/transactions']);
  });

  it('every label it can name is in the catalogue', () => {
    const keys = [
      ...PAGES_OUTSIDE_DESTINATIONS.map((page) => page.labelKey),
      ...Object.values(DESTINATION_TABS).flatMap((tabs) =>
        tabs.flatMap((tab) => [
          tab.labelKey,
          ...('tasks' in tab ? tab.tasks.map((task) => task.labelKey) : []),
        ]),
      ),
      'nav.breadcrumb',
    ];
    for (const key of keys) expect(() => message(key), key).not.toThrow();
  });
});
