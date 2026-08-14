/**
 * SPEC-005 BR-005-07 / SPEC-004 BR-004-02 / AR-54 — CPF is stripped **here**,
 * in the parser adapter, before anything is persisted and before a
 * `NormalizedRecord` is ever constructed. `core/` has no field for a CPF at
 * all, so this is the only place in the system where one can be found — and
 * the only place it needs to be removed.
 *
 * B3's Movimentação/Negociação extracts print an account-holder block —
 * name and CPF — in the leading metadata rows BR-005-04 already has to skip
 * to find the real header row. This runs over **every** cell value read from
 * the sheet regardless, not only that block: a free-text product or
 * description field is not contractually CPF-free, and defense in depth
 * costs nothing here.
 *
 * A CPF is stripped whether formatted (`123.456.789-09`) or bare
 * (`12345678909`). The bare form is checksum-validated before being touched,
 * so an 11-digit quantity or account number is never mistaken for one —
 * false positives here would silently corrupt real data, which is worse than
 * an occasional undetected bare CPF the punctuated pattern still catches.
 */

const CPF_PUNCTUATED = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g;
const CPF_BARE = /\b\d{11}\b/g;
const REDACTED = '[CPF removido]';

function checkDigit(digits: readonly number[], weightStart: number): number {
  const sum = digits.reduce((acc, digit, index) => acc + digit * (weightStart - index), 0);
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

/** The standard Brazilian CPF checksum — both verification digits, plus the all-repeated-digit rejection every real validator applies. */
export function isValidCpf(candidate: string): boolean {
  if (!/^\d{11}$/.test(candidate)) return false;
  if (/^(\d)\1{10}$/.test(candidate)) return false; // 00000000000, 11111111111, …

  const digits = candidate.split('').map(Number);
  const d1 = checkDigit(digits.slice(0, 9), 10);
  if (d1 !== digits[9]) return false;
  const d2 = checkDigit(digits.slice(0, 10), 11);
  return d2 === digits[10];
}

/** Redacts every CPF-shaped substring in `value`, formatted or bare-and-checksum-valid. */
export function stripCpf(value: string): string {
  const withoutPunctuated = value.replace(CPF_PUNCTUATED, REDACTED);
  return withoutPunctuated.replace(CPF_BARE, (match) => (isValidCpf(match) ? REDACTED : match));
}

/** Applied to every cell of a row before it becomes `import_rows.raw_payload` or crosses into a `NormalizedRecord`. */
export function sanitizeRow(row: Readonly<Record<string, string>>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    sanitized[key] = stripCpf(value);
  }
  return sanitized;
}

/**
 * The same redaction applied to a raw sheet row, **before any cell is read**.
 *
 * This is the load-bearing call, and `sanitizeRow` above is not sufficient on
 * its own: sanitising only at the point `raw_payload` is built leaves the
 * `NormalizedRecord` — which becomes `import_rows.parsed_payload` and is the
 * value that crosses into `core/` — derived from the untouched cells. A CPF in
 * any free-text cell would then be stripped from one column of the same row
 * and persisted in the other.
 *
 * Sanitising the cell array first means every downstream read, of either
 * payload, sees redacted text and there is no ordering to get wrong.
 */
export function sanitizeCells(row: readonly (string | null)[]): (string | null)[] {
  return row.map((cell) => (cell === null ? null : stripCpf(cell)));
}
