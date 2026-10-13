import { describe, expect, it, vi } from 'vitest';
import type { ImportBatchStatus } from '@/core/ingestion/ports';
import { IMPORT_BATCH_STATUSES } from '@/core/ingestion/ports';
import {
  ImportHistoryTable,
  type ImportHistoryRow,
} from '@/app/(app)/settings/import/_components/ImportHistoryTable';
import { BATCH_STATUS_VARIANT } from '@/app/(app)/settings/import/_components/batch-status';
import { audit, render, screen, within } from '@/components/test-utils';

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/import/history',
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const LABEL: Readonly<Record<ImportBatchStatus, string>> = {
  pending: 'Enviado, processando',
  previewed: 'Aguardando confirmação',
  committed: 'Importado',
  discarded: 'Cancelado',
  failed: 'Não foi possível processar',
};

function row(index: number, status: ImportBatchStatus, rowsRead: number | null): ImportHistoryRow {
  const day = String(index + 1).padStart(2, '0');
  return {
    id: `batch-${index}`,
    typeLabel: rowsRead === null ? 'Não identificado' : 'Negociação',
    status,
    statusLabel: LABEL[status],
    sentAtText: `${day}/09/2026 10:00`,
    sentAtMs: Date.UTC(2026, 8, index + 1, 13),
    rowsRead,
  };
}

/**
 * SPEC-022 BR-022-16/18/31 — Histórico is a table: newest first, sortable,
 * paginated, each status in its own semantic colour.
 */
describe('ImportHistoryTable', () => {
  it('shows type, sent at, status, rows and a link to the batch, newest first', () => {
    render(<ImportHistoryTable rows={[row(0, 'committed', 12), row(1, 'pending', null)]} />);
    const table = screen.getByRole('table', { name: /Histórico de importações/ });

    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual([
      expect.stringContaining('Tipo'),
      expect.stringContaining('Enviado em'),
      expect.stringContaining('Situação'),
      expect.stringContaining('Linhas'),
      'Ação',
    ]);

    const [first, second] = within(table).getAllByRole('row').slice(1);
    expect(first).toHaveTextContent('02/09/2026 10:00');
    expect(first).toHaveTextContent('Não identificado');
    expect(first).toHaveTextContent('—');
    expect(second).toHaveTextContent('Negociação');
    expect(second).toHaveTextContent('12');

    const link = within(second!).getByRole('link', { name: /Ver detalhes/ });
    expect(link).toHaveAttribute('href', '/settings/import/batch-0');
    expect(link).toHaveAccessibleName(/Negociação enviada em 01\/09\/2026 10:00/);
  });

  it('gives every status its own semantic badge — "Importado" is never the grey of "processando"', () => {
    const rows = IMPORT_BATCH_STATUSES.map((status, index) => row(index, status, 1));
    render(<ImportHistoryTable rows={rows} />);
    const table = screen.getByRole('table');

    for (const status of IMPORT_BATCH_STATUSES) {
      const badge = within(table).getByText(LABEL[status]);
      expect(badge).toHaveAttribute('data-variant', BATCH_STATUS_VARIANT[status]);
    }
    expect(new Set(Object.values(BATCH_STATUS_VARIANT)).size).toBe(IMPORT_BATCH_STATUSES.length);
    // DS-05: waiting on the user is a warning, never the destructive colour.
    expect(BATCH_STATUS_VARIANT.previewed).toBe('warning');
  });

  it('pages a long history instead of growing without bound', () => {
    const rows = Array.from({ length: 300 }, (_, index) => row(index % 28, 'committed', 5));
    render(<ImportHistoryTable rows={rows} />);
    const table = screen.getByRole('table');

    expect(within(table).getAllByRole('row')).toHaveLength(1 + 10);
    expect(screen.getAllByText(/de 300 importações/).length).toBeGreaterThan(0);
  });

  it('says how to start when there is no history', () => {
    render(<ImportHistoryTable rows={[]} />);
    expect(screen.getByText('Nenhum arquivo importado ainda.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <ImportHistoryTable rows={[row(0, 'committed', 12), row(1, 'failed', null)]} />,
    );
    expect(await audit(container)).toHaveNoViolations();
  });
});
