import ExcelJS from 'exceljs';
import { type DomainError, domainError } from '@/core/shared/domain-error';
import { type Result, err, ok } from '@/core/shared/result';
import { IngestionErrorCode, type IngestionPort, type ParsedExtract } from '@/core/ingestion/ports';
import { detectExtractType } from '@/adapters/ingestion/xlsx/detect';
import { CellFormatError, sheetToRows } from '@/adapters/ingestion/xlsx/common';
import { parseMovimentacao } from '@/adapters/ingestion/xlsx/movimentacao';
import { parseNegociacao } from '@/adapters/ingestion/xlsx/negociacao';
import { parsePosicao } from '@/adapters/ingestion/xlsx/posicao';

/**
 * SPEC-005 BR-005-08 — the `.xlsx` implementation of `IngestionPort`. This is
 * the only file in the feature that touches `exceljs`; everything else
 * consumes `ParsedExtract`/`NormalizedRecord`.
 *
 * AR-53: parsing runs in the **worker** (`src/worker/handlers/import.ts`
 * calls this), never the web process — a 10.000-row commit has a 60s budget
 * and a spreadsheet parser is an attack surface a request-serving process
 * should not carry.
 */
export class XlsxIngestionPort implements IngestionPort {
  async parse(
    fileBytes: Uint8Array,
  ): Promise<Result<ParsedExtract, DomainError<IngestionErrorCode>>> {
    const workbook = new ExcelJS.Workbook();
    try {
      // `exceljs` bundles a transitive, older `@types/node` whose `Buffer`
      // is structurally different from this project's (pnpm keeps several
      // `@types/node` versions side by side) — the two `Buffer` types do not
      // unify even though both are real `Buffer` at runtime. Casting through
      // the call's own inferred parameter type, rather than a hardcoded
      // `Buffer`, targets whichever declaration `load` actually expects
      // (DV-02 — the narrow, justified alternative to `any`).
      await workbook.xlsx.load(
        Buffer.from(fileBytes) as unknown as Parameters<typeof workbook.xlsx.load>[0],
      );
    } catch {
      return err(domainError(IngestionErrorCode.UNREADABLE_FILE));
    }

    const worksheet = workbook.worksheets.find((sheet) => sheet.rowCount > 0);
    if (worksheet === undefined) {
      return err(
        domainError(IngestionErrorCode.UNRECOGNIZED_STRUCTURE, {
          expected: 'at least one populated sheet',
        }),
      );
    }

    const rows = sheetToRows(worksheet);
    const detected = detectExtractType(rows);
    if (!detected.ok) return detected;

    const structure = detected.value;
    try {
      // BR-005-05 (#63) — a structurally valid extract can still carry a
      // malformed date or decimal in a data row. Before this `try`, that
      // threw a raw `TypeError` straight out of `import.stage`, crashing the
      // job instead of producing the `DomainError` this port promises;
      // pg-boss then retried a failure that would repeat identically on
      // every attempt. `CellFormatError` is the only exception this catches
      // deliberately narrow, so a genuine bug elsewhere in the parser still
      // surfaces as a real crash rather than a misleading "malformed file".
      const records =
        structure.extractType === 'b3_movimentacao'
          ? parseMovimentacao(rows, structure)
          : structure.extractType === 'b3_negociacao'
            ? parseNegociacao(rows, structure)
            : parsePosicao(rows, structure);

      return ok({ extractType: structure.extractType, records });
    } catch (error) {
      if (error instanceof CellFormatError) {
        // AR-39/BR-004-04: `column` and `expected` are structural metadata —
        // never the cell's own text, which could be anything, including a CPF.
        return err(
          domainError(IngestionErrorCode.MALFORMED_CELL, {
            extractType: structure.extractType,
            column: error.column,
            expected: error.expected,
          }),
        );
      }
      throw error;
    }
  }
}
