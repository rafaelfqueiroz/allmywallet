import { deflateRawSync } from 'node:zlib';

/**
 * TS-19/DV-24 (#171) — test support only, never imported by production code.
 * Builds **generated** COTAHIST fixtures: 245-character quote records from
 * named fields, and the single-entry ZIP archive `B3CotahistCloseSource`
 * reads. Nothing here is captured from a real B3 file — the real files this
 * task was verified against (per the dispatch brief) are never copied into
 * the repository or referenced by path from a test.
 *
 * Field positions follow B3's "SeriesHistoricas_Layout" (1-based, inclusive),
 * the same layout `cotahist.ts` parses against.
 */

const RECORD_LENGTH = 245;

function padRight(value: string, length: number, padChar = ' '): string {
  if (value.length >= length) return value.slice(0, length);
  return value + padChar.repeat(length - value.length);
}

function padLeft(value: string, length: number, padChar = '0'): string {
  if (value.length >= length) return value.slice(0, length);
  return padChar.repeat(length - value.length) + value;
}

/** `chars` is 0-based; `start1` is the field's 1-based layout position. */
function setField(chars: string[], start1: number, value: string): void {
  const start0 = start1 - 1;
  for (let i = 0; i < value.length; i += 1) {
    chars[start0 + i] = value[i] as string;
  }
}

/** `'2026-09-25'` -> `'20260925'` (DATPRE has no separators). */
function toDatpre(isoDate: string): string {
  return isoDate.replace(/-/g, '');
}

/** `'47.99'` -> `'0000000004799'` — PREULT's 13 digits, 2 implied decimals. */
function toPreultDigits(decimal: string): string {
  const [intPart, decPart = ''] = decimal.split('.');
  const digits = `${intPart}${padRight(decPart, 2, '0')}`;
  return padLeft(digits, 13);
}

export interface QuoteRecordFields {
  /** `'YYYY-MM-DD'` — converted to DATPRE's `AAAAMMDD`. */
  readonly datpre: string;
  /** Ticker, e.g. `'PETR4'` — placed at CODNEG (13–24), right-padded with spaces. */
  readonly codneg: string;
  /** Decimal string, e.g. `'47.99'` — placed at PREULT (109–121). */
  readonly preult: string;
  /** Default `'02'` (lot). */
  readonly codbdi?: string;
  /** Default `'010'` (spot market). */
  readonly tpmerc?: string;
  /** Integer string, default `'1'`. Placed at FATCOT (211–217). */
  readonly fatcot?: string;
  /** Default `'01'`. Set to something else to build a malformed/non-quote row for a test. */
  readonly tipreg?: string;
}

/** A `TIPREG=01` quote row, 245 characters, no line terminator. */
export function buildQuoteRecord(fields: QuoteRecordFields): string {
  const chars = new Array<string>(RECORD_LENGTH).fill(' ');
  setField(chars, 1, padRight(fields.tipreg ?? '01', 2));
  setField(chars, 3, toDatpre(fields.datpre));
  setField(chars, 11, padRight(fields.codbdi ?? '02', 2));
  setField(chars, 13, padRight(fields.codneg, 12));
  setField(chars, 25, padRight(fields.tpmerc ?? '010', 3));
  setField(chars, 109, toPreultDigits(fields.preult));
  setField(chars, 211, padLeft(fields.fatcot ?? '1', 7));
  return chars.join('');
}

/** The `TIPREG=00` header row — real files start `00COTAHIST.`. */
export function buildHeaderRecord(): string {
  return padRight('00COTAHIST.', RECORD_LENGTH);
}

/** The `TIPREG=99` trailer row. */
export function buildTrailerRecord(): string {
  return padRight('99COTAHIST.', RECORD_LENGTH);
}

export interface CotahistTextOptions {
  readonly omitHeader?: boolean;
  readonly omitTrailer?: boolean;
}

/** CRLF-joined records, header and trailer included by default — a whole COTAHIST text file. */
export function buildCotahistText(
  quoteRows: readonly QuoteRecordFields[],
  options: CotahistTextOptions = {},
): string {
  const lines: string[] = [];
  if (!options.omitHeader) lines.push(buildHeaderRecord());
  for (const row of quoteRows) lines.push(buildQuoteRecord(row));
  if (!options.omitTrailer) lines.push(buildTrailerRecord());
  return lines.map((line) => `${line}\r\n`).join('');
}

// ---------------------------------------------------------------------------
// A hand-rolled single-entry ZIP writer — CRC-32 and the local/central/EOCD
// records `zip-entry.ts` reads back. No dependency: `node:zlib` supplies
// deflate, the rest is ~60 lines of the ZIP spec's fixed-size records.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i] as number;
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipBuildOptions {
  /** `8` (deflate, default) or `0` (stored). */
  readonly method?: 0 | 8;
  /**
   * General-purpose bit 3: the local header's crc/sizes are zeroed and a
   * data descriptor trails the compressed data instead — the variant B3's
   * own archiver sometimes produces, which is exactly why `zip-entry.ts`
   * reads sizes from the central directory rather than the local header.
   */
  readonly useDataDescriptor?: boolean;
  readonly entryName?: string;
}

const ARBITRARY_MSDOS_DATE = 0x21; // any structurally valid value; its content is never read

/** A minimal, valid, single-entry ZIP archive holding `text` as `entryName`. */
export function buildSingleEntryZip(text: string, options: ZipBuildOptions = {}): Buffer {
  const method = options.method ?? 8;
  const useDataDescriptor = options.useDataDescriptor ?? false;
  const entryName = options.entryName ?? 'COTAHIST_D25092026.TXT';

  const uncompressed = Buffer.from(text, 'latin1');
  const compressed = method === 8 ? deflateRawSync(uncompressed) : uncompressed;
  const crc = crc32(uncompressed);
  const nameBuf = Buffer.from(entryName, 'utf8');
  const gpFlag = useDataDescriptor ? 0x0008 : 0x0000;

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(gpFlag, 6);
  localHeader.writeUInt16LE(method, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(ARBITRARY_MSDOS_DATE, 12);
  localHeader.writeUInt32LE(useDataDescriptor ? 0 : crc, 14);
  localHeader.writeUInt32LE(useDataDescriptor ? 0 : compressed.length, 18);
  localHeader.writeUInt32LE(useDataDescriptor ? 0 : uncompressed.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28);

  let dataDescriptor = Buffer.alloc(0);
  if (useDataDescriptor) {
    dataDescriptor = Buffer.alloc(16);
    dataDescriptor.writeUInt32LE(0x08074b50, 0);
    dataDescriptor.writeUInt32LE(crc, 4);
    dataDescriptor.writeUInt32LE(compressed.length, 8);
    dataDescriptor.writeUInt32LE(uncompressed.length, 12);
  }

  const localSection = Buffer.concat([localHeader, nameBuf, compressed, dataDescriptor]);
  const localHeaderOffset = 0;

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(gpFlag, 8);
  centralHeader.writeUInt16LE(method, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(ARBITRARY_MSDOS_DATE, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(uncompressed.length, 24);
  centralHeader.writeUInt16LE(nameBuf.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(localHeaderOffset, 42);

  const centralSection = Buffer.concat([centralHeader, nameBuf]);
  const centralDirOffset = localSection.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralSection.length, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localSection, centralSection, eocd]);
}

/** `buildCotahistText` piped straight into `buildSingleEntryZip` — the common case. */
export function buildCotahistZip(
  quoteRows: readonly QuoteRecordFields[],
  textOptions: CotahistTextOptions = {},
  zipOptions: ZipBuildOptions = {},
): Buffer {
  return buildSingleEntryZip(buildCotahistText(quoteRows, textOptions), zipOptions);
}
