import { describe, expect, it } from 'vitest';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { audit, render, screen, userEvent, waitFor } from '@/components/test-utils';

function ReportTabs() {
  return (
    <Tabs defaultValue="composicao">
      <TabsList>
        <TabsTrigger value="composicao">Composição</TabsTrigger>
        <TabsTrigger value="proventos">Proventos</TabsTrigger>
      </TabsList>
      <TabsContent value="composicao">Por classe de ativo</TabsContent>
      <TabsContent value="proventos">Recebidos no período</TabsContent>
    </Tabs>
  );
}

describe('Tabs', () => {
  it('shows only the selected panel', () => {
    render(<ReportTabs />);
    expect(screen.getByText('Por classe de ativo')).toBeInTheDocument();
    expect(screen.queryByText('Recebidos no período')).not.toBeInTheDocument();
  });

  it('marks the selected tab for assistive technology', () => {
    render(<ReportTabs />);
    expect(screen.getByRole('tab', { name: 'Composição' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('moves between tabs with the arrow keys', async () => {
    const user = userEvent.setup();
    render(<ReportTabs />);

    await user.tab();
    expect(screen.getByRole('tab', { name: 'Composição' })).toHaveFocus();

    await user.keyboard('{ArrowRight}');

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Proventos' })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    expect(screen.getByText('Recebidos no período')).toBeInTheDocument();
  });

  it('carries a focus-visible ring on its triggers', () => {
    render(<ReportTabs />);
    expect(screen.getByRole('tab', { name: 'Composição' }).className).toContain('focus-visible:');
  });

  it('has no axe violations', async () => {
    const { container } = render(<ReportTabs />);
    expect(await audit(container)).toHaveNoViolations();
  });
});
