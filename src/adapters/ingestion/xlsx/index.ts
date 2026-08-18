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

    /**
     * BR-005-01 / AC-005-06 (#63) — **every** populated sheet, not the first.
     *
     * A real B3 Posição export is a multi-tab workbook, one tab per asset
     * class, and this took `worksheets.find(...)`: the first populated sheet
     * won and the rest of the file was discarded in silence. A user importing
     * a Posição with a fixed-income tab got their equities and none of their
     * CDBs — and, because BR-005-06 reads contracted rates from that tab, no
     * fixed-income contracts either, so every bank paper they held would later
     * value at cost and sit in "Needs attention" with no visible cause.
     *
     * A sheet whose headers do not match any known schema is skipped rather
     * than failing the import: exports carry cover and notes tabs, and refusing
     * the whole file over one would make the feature unusable. The backstop is
     * that staging reports its row counts *before* the user commits (BR-005-11)
     * — a tab that failed to parse shows up as a count lower than the file, at
     * the one moment the user is looking at exactly that number.
     */
    const sheets = workbook.worksheets
      .filter((sheet) => sheet.rowCount > 0)
      .map((sheet) => sheetToRows(sheet));

    if (sheets.length === 0) {
      return err(
        domainError(IngestionErrorCode.UNRECOGNIZED_STRUCTURE, {
          expected: 'at least one populated sheet',
        }),
      );
    }

    const recognized = sheets.flatMap((rows) => {
      const detected = detectExtractType(rows);
      return detected.ok ? [{ rows, structure: detected.value }] : [];
    });

    const first = recognized[0];
    if (first === undefined) {
      // Report the first sheet's own detection failure rather than a generic
      // one: for the single-sheet case — still the common one — this is
      // exactly the error the caller used to get, naming the headers it wanted.
      const firstSheet = sheets[0];
      const detected = firstSheet === undefined ? undefined : detectExtractType(firstSheet);
      if (detected !== undefined && !detected.ok) return detected;
      return err(domainError(IngestionErrorCode.UNRECOGNIZED_STRUCTURE, {}));
    }

    const structure = first.structure;

    // Two different extracts in one workbook is a mistake worth naming, not
    // something to merge: `ParsedExtract` carries a single `extractType`, and
    // guessing which one wins would attribute one extract's rows to the other.
    if (recognized.some((sheet) => sheet.structure.extractType !== structure.extractType)) {
      return err(
        domainError(IngestionErrorCode.UNRECOGNIZED_STRUCTURE, {
          expected: 'one extract type per workbook',
        }),
      );
    }

    try {
      // BR-005-05 (#63) — a structurally valid extract can still carry a
      // malformed date or decimal in a data row. Before this `try`, that
      // threw a raw `TypeError` straight out of `import.stage`, crashing the
      // job instead of producing the `DomainError` this port promises;
      // pg-boss then retried a failure that would repeat identically on
      // every attempt. `CellFormatError` is the only exception this catches
      // deliberately narrow, so a genuine bug elsewhere in the parser still
      // surfaces as a real crash rather than a misleading "malformed file".
      // Each sheet keeps its own `structure`: the header row index differs per
      // tab (metadata blocks are not identical across them) and BR-005-04 lets
      // column order differ too, so reusing the first sheet's offsets would
      // read the wrong columns on every tab after it.
      const records = recognized.flatMap((sheet) =>
        sheet.structure.extractType === 'b3_movimentacao'
          ? parseMovimentacao(sheet.rows, sheet.structure)
          : sheet.structure.extractType === 'b3_negociacao'
            ? parseNegociacao(sheet.rows, sheet.structure)
            : parsePosicao(sheet.rows, sheet.structure),
      );

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
