import { describe, expect, it } from 'vitest';
import { aggregate } from '@/core/reporting/base-query';
import {
  defaultGroupLabeller,
  exportGroupedCsv,
  type CsvLabels,
} from '@/core/reporting/export-csv';
import { aHolding, assetIdOf, money, qty, walletIdOf } from '@/core/reporting/test-support';

/**
 * SPEC-011 BR-011-12 / AC-11 — "CSV export preserves the grouping and
 * neutralises formula-injection cells."
 */

const LABELS: CsvLabels = {
  group: 'Grupo',
  assetCode: 'Ativo',
  assetName: 'Nome',
  quantity: 'Quantidade',
  value: 'Valor',
  costBasis: 'Custo',
  estimated: 'Estimado',
  unassigned: 'Não atribuído',
  notClassified: 'Não classificado',
  yes: 'Sim',
  no: 'Não',
  total: 'Total',
};

describe('exportGroupedCsv — BR-011-12', () => {
  const holdings = [
    aHolding({
      assetId: assetIdOf('1'),
      assetCode: 'ITSA4',
      assetName: 'Itausa PN',
      assetClass: 'stock',
      walletId: walletIdOf('1'),
      quantity: qty('60'),
      value: money('600'),
      costBasis: money('480'),
    }),
    aHolding({
      assetId: assetIdOf('2'),
      assetCode: 'CDB BANCO X',
      assetName: 'CDB 110% CDI',
      assetClass: 'cdb',
      sector: null,
      walletId: null,
      quantity: qty('1'),
      value: money('1050.55'),
      costBasis: money('1000'),
      estimated: true,
    }),
  ];

  const names = new Map([[walletIdOf('1'), 'Aposentadoria']]);

  it('preserves the grouping in the first column', () => {
    const report = aggregate(holdings, 'wallet');
    const csv = exportGroupedCsv(report, LABELS, defaultGroupLabeller(LABELS, names));
    const lines = csv.split('\r\n');

    expect(lines[0]).toBe('Grupo,Ativo,Nome,Quantidade,Valor,Custo,Estimado');
    expect(lines[1]).toBe('Aposentadoria,ITSA4,Itausa PN,60,600,480,Não');
    // BR-011-09: the Unassigned bucket exports under its i18n label, not its
    // sentinel id, and not as an empty cell.
    expect(lines[2]).toBe('Não atribuído,CDB BANCO X,CDB 110% CDI,1,1050.55,1000,Sim');
  });

  it('appends the scope total so the export is self-checking', () => {
    const report = aggregate(holdings, 'wallet');
    const lines = exportGroupedCsv(report, LABELS, defaultGroupLabeller(LABELS, names)).split(
      '\r\n',
    );
    // 600 + 1050.55 = 1650.55; quantity 60 + 1 = 61; cost 480 + 1000 = 1480.
    expect(lines.at(-1)).toBe('Total,,,61,1650.55,1480,Sim');
  });

  it('labels the Not classified bucket under a non-wallet dimension', () => {
    const report = aggregate(holdings, 'sector');
    const csv = exportGroupedCsv(report, LABELS, defaultGroupLabeller(LABELS, new Map()));
    expect(csv).toContain('Não classificado,CDB BANCO X');
    expect(csv).not.toContain('__not_classified__');
  });

  it('falls back to the group id when no display name was resolved', () => {
    // Never an empty cell — a group with no name still has to be identifiable.
    const report = aggregate(holdings, 'wallet');
    const csv = exportGroupedCsv(report, LABELS, defaultGroupLabeller(LABELS, new Map()));
    expect(csv).toContain(walletIdOf('1'));
  });

  it('emits money at full precision, never rounded or locale-formatted', () => {
    // AR-06/AR-10: a CSV is data. `R$ 1.234,56` would be re-parsed by a
    // spreadsheet as text, or as a different number.
    const report = aggregate(
      [
        aHolding({
          quantity: qty('3'),
          value: money('1234.56789012'),
          costBasis: money('0.00000001'),
        }),
      ],
      'asset',
    );
    const csv = exportGroupedCsv(report, LABELS, () => 'G');
    expect(csv).toContain('1234.56789012');
    expect(csv).toContain('0.00000001');
    expect(csv).not.toContain('R$');
    expect(csv).not.toContain('1.234,56');
  });

  it('renders an empty report as a header and a zero total, never as nothing', () => {
    const csv = exportGroupedCsv(aggregate([], 'asset_class'), LABELS, () => '');
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('Total,,,0,0,0,Não');
  });
});

describe('BR-011-12 / AR-55 — formula injection is neutralised by src/lib/csv.ts', () => {
  it('neutralises a cell beginning with = + - or @', () => {
    // The threat is real for this product specifically: an institution name or
    // an asset name arrives from a parsed B3 extract, so it is attacker-
    // influenceable text that lands in a spreadsheet the user opens.
    const report = aggregate(
      [
        aHolding({ assetCode: "=cmd|'/c calc'!A1", assetName: '+SUM(A1:A9)' }),
        aHolding({ assetCode: '-2+3', assetName: '@SUM(1)' }),
      ],
      'asset',
    );
    const csv = exportGroupedCsv(report, LABELS, () => 'G');

    // Each trigger character is prefixed with a single quote, which Excel and
    // LibreOffice both read as "this cell is text".
    expect(csv).toContain("'=cmd|'/c calc'!A1");
    expect(csv).toContain("'+SUM(A1:A9)");
    expect(csv).toContain("'-2+3");
    expect(csv).toContain("'@SUM(1)");
    // ...and no cell survives starting with a bare trigger character.
    for (const line of csv.split('\r\n')) {
      for (const cell of line.split(',')) {
        expect(['=', '+', '@'].some((c) => cell.startsWith(c))).toBe(false);
      }
    }
  });

  it('neutralises a hostile group label too', () => {
    // The group column is just as exportable as the data columns, and a wallet
    // name is user-supplied text.
    const report = aggregate([aHolding({})], 'wallet');
    const csv = exportGroupedCsv(report, LABELS, () => '=HYPERLINK("http://x","click")');
    expect(csv).toContain("'=HYPERLINK");
  });

  it('still quotes fields containing commas, quotes or newlines (RFC 4180)', () => {
    const report = aggregate([aHolding({ assetName: 'Banco, S.A. "BSA"' })], 'asset');
    const csv = exportGroupedCsv(report, LABELS, () => 'G');
    expect(csv).toContain('"Banco, S.A. ""BSA"""');
  });
});
