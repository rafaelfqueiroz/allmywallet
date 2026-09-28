import { createInflateRaw } from 'node:zlib';
import { Readable } from 'node:stream';

/**
 * SPEC-008 BR-008-30 — a minimal, single-entry ZIP reader built on
 * `node:zlib` alone (no new dependency). B3's COTAHIST files are always
 * exactly one entry: `COTAHIST_D25092026.TXT` inside `COTAHIST_D25092026.ZIP`,
 * usually deflate (method 8), occasionally stored (method 0).
 *
 * Reads the End Of Central Directory record to find the central directory,
 * which is what's authoritative for the entry's `compressedSize` and
 * `method` — the local header's own size fields are zero whenever
 * general-purpose bit 3 (a trailing data descriptor) is set, so they are
 * never trusted here, only the local header's name/extra-field *lengths*
 * (needed to find where the entry's data actually starts).
 *
 * The compressed bytes are handed to the caller as a stream — for method 8,
 * piped through `zlib.createInflateRaw()` — so a 90 MB annual file is never
 * held in memory decompressed (the compressed archive itself is, which the
 * caller has to buffer anyway to read its trailer).
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

/** Fixed part of the End Of Central Directory record, before its (possibly empty) comment. */
const EOCD_MIN_SIZE = 22;
/** `comment length` is a 16-bit field — this is its maximum possible value. */
const MAX_COMMENT_LENGTH = 65535;

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(`zip: ${message}`);
    this.name = 'ZipFormatError';
  }
}

export interface ZipEntry {
  readonly method: number;
  /** The entry's **decompressed** bytes (stored: passed through; deflate: inflated). */
  readonly stream: Readable;
}

/**
 * Scans backward from the end of the archive for the EOCD signature — the
 * only way to find it, since it is preceded by a variable-length (0–65535
 * byte) comment field with nothing declaring its own length ahead of time.
 */
function findEndOfCentralDirectory(buffer: Buffer): number {
  const searchFloor = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT_LENGTH);
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= searchFloor; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

/**
 * Reads the single entry a COTAHIST ZIP holds. Throws `ZipFormatError` for
 * anything that does not parse as a well-formed single-entry ZIP; the
 * adapter catches this and reports `OfficialCloseSourceErrorCode.UNAVAILABLE`
 * — a malformed file is never allowed to propagate out of `fetchDay`/`fetchYear`.
 */
export function openSingleZipEntry(buffer: Buffer): ZipEntry {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) {
    throw new ZipFormatError('End Of Central Directory record not found');
  }

  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (
    centralDirOffset + 46 > buffer.length ||
    buffer.readUInt32LE(centralDirOffset) !== CENTRAL_DIR_SIGNATURE
  ) {
    throw new ZipFormatError('central directory record not found');
  }

  const method = buffer.readUInt16LE(centralDirOffset + 10);
  const compressedSize = buffer.readUInt32LE(centralDirOffset + 20);
  const localHeaderOffset = buffer.readUInt32LE(centralDirOffset + 42);

  if (
    localHeaderOffset + 30 > buffer.length ||
    buffer.readUInt32LE(localHeaderOffset) !== LOCAL_HEADER_SIGNATURE
  ) {
    throw new ZipFormatError('local file header not found');
  }
  // Never the local header's own compressed/uncompressed-size fields: with
  // general-purpose bit 3 set (a trailing data descriptor) they are zero.
  // Its name/extra-field lengths are trustworthy — they say where the entry's
  // data starts, nothing about how big it is.
  const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;

  if (dataOffset + compressedSize > buffer.length) {
    throw new ZipFormatError('entry data runs past the end of the archive');
  }

  const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);

  if (method === 0) {
    return { method, stream: Readable.from(compressed) };
  }
  if (method === 8) {
    const inflater = createInflateRaw();
    const source = Readable.from(compressed);
    source.on('error', (error) => inflater.destroy(error));
    source.pipe(inflater);
    return { method, stream: inflater };
  }
  throw new ZipFormatError(`unsupported compression method ${method}`);
}
