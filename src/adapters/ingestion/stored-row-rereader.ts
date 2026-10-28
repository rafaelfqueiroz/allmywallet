import type {
  ExtractType,
  ImportRowRereader,
  NormalizedRecord,
  RawRow,
} from '@/core/ingestion/ports';
import { parseMovimentacao } from '@/adapters/ingestion/xlsx/movimentacao';

/**
 * SPEC-022 BR-022-35 (#215) — a stored Movimentação row read again by the
 * parser this build ships.
 *
 * `raw_payload` is keyed by the same normalised headers `DetectedStructure`
 * maps to column indexes (`movimentacao.ts`'s `rawRowOf`), so the stored row
 * is laid back out as a one-row sheet and handed to `parseMovimentacao`
 * unchanged. That is what makes a parser fix count: #192 recovered a price
 * from `Valor da Operação`, which the stored `parsed_payload` of an earlier
 * import does not carry.
 *
 * No workbook is opened — the cells are strings already stripped of CPF at
 * the original parse (BR-005-07) — so AR-53's reason for keeping `exceljs` in
 * the worker does not reach this. It sits outside `xlsx/` for the same reason:
 * it reads nothing from B3 that the parser does not, so it is not part of the
 * fingerprint SPEC-020 BR-020-25 ties the export guide's stamp to. Only Movimentação: every Negociação row is a
 * `Compra` or `Venda`, which every map version has classified, and Posição
 * rows never need attention.
 */
export class XlsxImportRowRereader implements ImportRowRereader {
  reread(source: ExtractType, raw: RawRow): NormalizedRecord | null {
    if (source !== 'b3_movimentacao') return null;
    const headers = Object.keys(raw);
    const structure = {
      extractType: source,
      headerRowIndex: -1,
      columns: new Map(headers.map((header, index) => [header, index])),
    };
    // `rawRowOf` stored a blank cell as `''`; the parser reads blanks as null.
    const cells = headers.map((header) => (raw[header] === '' ? null : (raw[header] ?? null)));
    try {
      return parseMovimentacao([cells], structure)[0]?.record ?? null;
    } catch {
      // A cell an earlier parser accepted and this one refuses: the stored
      // record still stands, and the queue reads it as before.
      return null;
    }
  }
}
