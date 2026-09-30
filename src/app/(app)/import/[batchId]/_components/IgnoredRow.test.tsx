import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { AssetId, ImportBatchId, ImportRowId, TransactionId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type { ImportRow, NormalizedTransactionRecord } from '@/core/ingestion/ports';
import { render, screen } from '@/components/test-utils';
import { List } from '@/components/layout/list';
import { IgnoredRow } from './IgnoredRow';

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

describe('IgnoredRow (SPEC-005 BR-005-19/20d, #179)', () => {
  it('keeps a resolved exercise visible without a classify form', () => {
    render(
      <List>
        <IgnoredRow
          row={exercise}
          committed
          resolvedExerciseLabel="Exercício resolvido no ativo principal"
          classifyForm={classifyForm}
        />
      </List>,
    );

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

    render(
      <List>
        <IgnoredRow
          row={mirror}
          committed
          resolvedExerciseLabel="Exercício resolvido no ativo principal"
          classifyForm={classifyForm}
        />
      </List>,
    );

    expect(screen.getByText('XXXX11')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Classificar ${mirror.id}` })).toBeInTheDocument();
    expect(screen.queryByText('Exercício resolvido no ativo principal')).not.toBeInTheDocument();
  });
});
