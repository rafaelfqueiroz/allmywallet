import { type DomainError, domainError } from '@/core/shared/domain-error';
import { type Result, err, ok } from '@/core/shared/result';
import { IngestionErrorCode, type ExtractType } from '@/core/ingestion/ports';

/**
 * SPEC-005 BR-005-03/04/05 — structure-based extract detection.
 *
 * Deliberately independent of `exceljs`: this operates on plain
 * `(string | null)[][]` — a worksheet already reduced to cell text — so it is
 * unit-testable with hand-built arrays and reusable by all three parsers
 * without each one re-implementing header matching. `index.ts` is what
 * bridges an actual `ExcelJS.Worksheet` into this shape.
 *
 * Users rename downloads (DL-005-03), so the filename is never consulted —
 * only structure is. Detection tolerates leading metadata rows (B3 extracts
 * open with an account-holder block before the real header row) by scanning
 * a window of candidate rows rather than assuming row 1 is the header.
 */

export interface ExtractSchema {
  readonly extractType: ExtractType;
  /** Normalised (case/accent/whitespace-folded) header names, order-independent. */
  readonly requiredHeaders: readonly string[];
}

/**
 * BR-005-01: each extract's column set. Order-independent (BR-005-04 — B3
 * changing column order must not break the parser).
 *
 * One schema set covers both a flattened single-sheet Posição and B3's real
 * multi-tab workbook, because detection runs **per sheet** (`index.ts`, #63)
 * and every Posição tab carries the same column set. A workbook's tabs are
 * therefore detected independently, and one that matches no schema — a cover
 * or notes tab — is skipped rather than failing the whole import.
 */
export const EXTRACT_SCHEMAS: readonly ExtractSchema[] = [
  {
    extractType: 'b3_movimentacao',
    requiredHeaders: [
      'entrada/saida',
      'data',
      'movimentacao',
      'produto',
      'instituicao',
      'quantidade',
      'preco unitario',
      'valor da operacao',
    ],
  },
  {
    extractType: 'b3_negociacao',
    requiredHeaders: [
      'data do negocio',
      'tipo',
      'mercado',
      'codigo de negociacao',
      'quantidade',
      'preco',
      'valor',
    ],
  },
  {
    extractType: 'b3_posicao',
    requiredHeaders: ['produto', 'instituicao', 'categoria', 'quantidade', 'data de referencia'],
  },
];

/** BR-005-04: the same fold `core/ingestion/movement-map.ts` uses for B3 type strings. */
export function normalizeHeader(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export interface DetectedStructure {
  readonly extractType: ExtractType;
  readonly headerRowIndex: number;
  /** Normalised header → column index, so a parser reads columns by name, order-independent. */
  readonly columns: ReadonlyMap<string, number>;
}

/** How many leading rows (account-holder block, report title) BR-005-04 tolerates before a header row. */
const MAX_METADATA_ROWS = 15;

interface Candidate {
  readonly schema: ExtractSchema;
  readonly rowIndex: number;
  readonly score: number;
  readonly columns: ReadonlyMap<string, number>;
}

export function detectExtractType(
  rows: readonly (readonly (string | null)[])[],
): Result<DetectedStructure, DomainError<IngestionErrorCode>> {
  const candidates: Candidate[] = [];

  const window = rows.slice(0, MAX_METADATA_ROWS + 1);
  for (const [rowIndex, row] of window.entries()) {
    const columns = columnsOf(row);
    if (columns.size === 0) continue;

    for (const schema of EXTRACT_SCHEMAS) {
      const matched = schema.requiredHeaders.filter((header) => columns.has(header)).length;
      const score = matched / schema.requiredHeaders.length;
      if (score > 0) candidates.push({ schema, rowIndex, score, columns });
    }
  }

  if (candidates.length === 0) {
    return err(
      domainError(IngestionErrorCode.UNRECOGNIZED_STRUCTURE, {
        expected: EXTRACT_SCHEMAS.map((s) => s.extractType).join(', '),
      }),
    );
  }

  const best = candidates.reduce((a, b) => (b.score > a.score ? b : a));
  if (best.score < 1) {
    return err(
      domainError(IngestionErrorCode.UNRECOGNIZED_STRUCTURE, {
        closestMatch: best.schema.extractType,
        expected: best.schema.requiredHeaders.join(', '),
        matchedFraction: best.score,
      }),
    );
  }

  // BR-005-05: two schemas matching the same header row equally well is
  // genuinely ambiguous — never guessed at.
  const tiedWinners = candidates.filter(
    (c) => c.rowIndex === best.rowIndex && c.score === best.score,
  );
  if (tiedWinners.length > 1) {
    return err(
      domainError(IngestionErrorCode.AMBIGUOUS_STRUCTURE, {
        candidates: tiedWinners.map((c) => c.schema.extractType).join(', '),
      }),
    );
  }

  return ok({
    extractType: best.schema.extractType,
    headerRowIndex: best.rowIndex,
    columns: best.columns,
  });
}

function columnsOf(row: readonly (string | null)[]): Map<string, number> {
  const columns = new Map<string, number>();
  row.forEach((cell, index) => {
    if (cell === null) return;
    const normalized = normalizeHeader(cell);
    if (normalized === '') return;
    columns.set(normalized, index);
  });
  return columns;
}
