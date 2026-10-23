import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { AssetId, ImportBatchId, ImportRowId, TransactionId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type { ImportRow, NormalizedTransactionRecord } from '@/core/ingestion/ports';
import { render, screen } from '@/components/test-utils';
import { ignoredRow } from './IgnoredRow';

const exerciseRecord: NormalizedTransactionRecord = {
  kind: 'transaction',
  priceStated: false,
  b3Type: 'Direitos de Subscrição - Exercido',
  direction: 'debit',
  assetCode: 'XXXX12',
  assetName: 'Direito sintético',
  assetClass: 'fii',
  institutionName: 'Corretora Teste',
  tradeDate: BusinessDate.of('2024-01-22'),
  quantity: Quantity.fromString('3'),
  unitPrice: Money.zero(),
  fees: Money.zero(),
  ratio: null,
};

const exercise: ImportRow = {
  id: ImportRowId.generate(),
  batchId: ImportBatchId.generate(),
  raw: { Movimentação: 'Direitos de Subscrição - Exercido' },
  record: exerciseRecord,
  assetId: AssetId.generate(),
  institutionId: null,
  classification: 'ignored',
  naturalKey: 'synthetic-exercise',
  occurrence: 1,
  ledgerType: 'subscription',
  transactionId: TransactionId.generate(),
};

const classifyForm = (rowId: string) => <button type="button">{`Classificar ${rowId}`}</button>;

/** The row's cells, rendered side by side as a table row would show them. */
function renderRow(row: ImportRow) {
  const { id, cells } = ignoredRow({
    row,
    committed: true,
    resolvedExerciseLabel: 'Exercício resolvido no ativo principal',
    reasonLabel: 'Motivo:',
    classifyForm,
  });
  expect(id).toBe(row.id);
  return render(
    <ul>
      {Object.entries(cells).map(([column, cell]) => (
        <li key={column}>{cell}</li>
      ))}
    </ul>,
  );
}

describe('ignoredRow (SPEC-005 BR-005-19/20d, #179)', () => {
  it('keeps a resolved exercise visible without a classify form', () => {
    renderRow(exercise);

    expect(screen.getByText('XXXX12')).toBeInTheDocument();
    expect(screen.getByText('Exercício resolvido no ativo principal')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Classificar/ })).not.toBeInTheDocument();
  });

  it('still offers classification for an ordinary ignored mirror in a committed batch', () => {
    const mirror: ImportRow = {
      ...exercise,
      id: ImportRowId.generate(),
      record: {
        ...exerciseRecord,
        b3Type: 'Transferência - Liquidação',
        assetCode: 'XXXX11',
      },
      ledgerType: 'rendimento',
      transactionId: null,
    };

    renderRow(mirror);

    expect(screen.getByText('XXXX11')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Classificar ${mirror.id}` })).toBeInTheDocument();
    expect(screen.queryByText('Exercício resolvido no ativo principal')).not.toBeInTheDocument();
  });

  it('shows the reason a user gave for ignoring the row (BR-005-20f)', () => {
    const settled: ImportRow = {
      ...exercise,
      id: ImportRowId.generate(),
      record: { ...exerciseRecord, b3Type: 'Atualização', assetCode: 'BBAS3' },
      ledgerType: null,
      ignoredReason: 'Saldo antes da liquidação da compra',
    };

    renderRow(settled);

    expect(screen.getByText('Motivo: Saldo antes da liquidação da compra')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Classificar ${settled.id}` })).toBeInTheDocument();
  });

  it('shows no reason for a row a rule ignored', () => {
    renderRow({ ...exercise, ignoredReason: null });

    expect(screen.queryByText(/Motivo:/)).not.toBeInTheDocument();
  });
});
