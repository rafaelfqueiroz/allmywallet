import { describe, expect, it } from 'vitest';
import { Breadcrumb } from '@/components/patterns/breadcrumb';
import { audit, render, screen, within } from '@/components/test-utils';

const ITEMS = [
  { href: '/settings', label: 'Configurações' },
  { href: '/settings/import', label: 'Importar' },
  { href: '/settings/import/history', label: 'Histórico' },
];

// SPEC-022 BR-022-09 (amended, DL-022-27).
describe('Breadcrumb', () => {
  it('is a named navigation landmark holding an ordered list', () => {
    render(<Breadcrumb label="Você está em" items={ITEMS} />);

    const nav = screen.getByRole('navigation', { name: 'Você está em' });
    expect(within(nav).getByRole('list').tagName).toBe('OL');
    expect(within(nav).getAllByRole('listitem')).toHaveLength(3);
  });

  it('links every earlier crumb to its level', () => {
    render(<Breadcrumb label="Você está em" items={ITEMS} />);

    expect(screen.getByRole('link', { name: 'Configurações' })).toHaveAttribute(
      'href',
      '/settings',
    );
    expect(screen.getByRole('link', { name: 'Importar' })).toHaveAttribute(
      'href',
      '/settings/import',
    );
  });

  it('makes the last crumb the current page, not a link', () => {
    render(<Breadcrumb label="Você está em" items={ITEMS} />);

    expect(screen.queryByRole('link', { name: 'Histórico' })).toBeNull();
    expect(screen.getByText('Histórico')).toHaveAttribute('aria-current', 'page');
  });

  it('renders nothing for an empty trail', () => {
    const { container } = render(<Breadcrumb label="Você está em" items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('has no axe violations', async () => {
    const { container } = render(<Breadcrumb label="Você está em" items={ITEMS} />);
    expect(await audit(container)).toHaveNoViolations();
  });
});
