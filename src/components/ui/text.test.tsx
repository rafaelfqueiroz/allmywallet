import { describe, expect, it } from 'vitest';
import { Text } from '@/components/ui/text';
import { List, ListItem } from '@/components/layout/list';
import { audit, render, screen } from '@/components/test-utils';

describe('Text', () => {
  it('maps each tone to a semantic token, never a palette colour', () => {
    const tones = {
      default: 'text-foreground',
      muted: 'text-muted-foreground',
      destructive: 'text-destructive',
      positive: 'text-positive',
      negative: 'text-negative',
    } as const;

    for (const [tone, expected] of Object.entries(tones)) {
      const { container, unmount } = render(
        <Text tone={tone as keyof typeof tones}>conteúdo</Text>,
      );
      expect(container.querySelector('[data-slot="text"]')?.className).toContain(expected);
      unmount();
    }
  });

  it('renders as the requested element', () => {
    const { container } = render(<Text as="span">conteúdo</Text>);
    expect(container.querySelector('span[data-slot="text"]')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<Text tone="muted">conteúdo</Text>);
    expect(await audit(container)).toHaveNoViolations();
  });
});

describe('List', () => {
  /*
   * Why this is not just `Stack`: putting a `<div>` between a `<ul>` and its
   * `<li>` children to get a gap breaks the relationship a screen reader
   * announces as "list, two items" — the same class of defect axe caught in
   * DataTable's `dl`.
   */
  it('keeps list semantics — the gap is on the ul itself', () => {
    render(
      <List gap="md">
        <ListItem>um</ListItem>
        <ListItem>dois</ListItem>
      </List>,
    );

    const list = screen.getByRole('list');
    expect(list.tagName).toBe('UL');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(list.firstElementChild?.tagName).toBe('LI');
  });

  it('folds the separator, its padding and the last-child reset into one variant', () => {
    render(<ListItem separated>um</ListItem>);
    const className = screen.getByRole('listitem').className;

    expect(className).toContain('border-b');
    expect(className).toContain('last:border-0');
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <List>
        <ListItem separated>um</ListItem>
      </List>,
    );
    expect(await audit(container)).toHaveNoViolations();
  });
});
