import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import { buildSingleEntryZip } from './cotahist-fixture';
import { openSingleZipEntry, ZipFormatError } from './zip-entry';

async function readLines(stream: NodeJS.ReadableStream): Promise<string[]> {
  stream.setEncoding('latin1');
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const lines: string[] = [];
  for await (const line of rl) lines.push(line);
  return lines;
}

const SAMPLE_TEXT = 'line one\r\nline two\r\nline three\r\n';

describe('openSingleZipEntry (SPEC-008 BR-008-30 support, #171)', () => {
  it('reads a deflate (method 8) entry back to its original text', async () => {
    const zip = buildSingleEntryZip(SAMPLE_TEXT, { method: 8 });
    const entry = openSingleZipEntry(zip);
    expect(entry.method).toBe(8);
    expect((await readLines(entry.stream)).join('\r\n') + '\r\n').toBe(SAMPLE_TEXT);
  });

  it('reads a stored (method 0) entry back to its original text', async () => {
    const zip = buildSingleEntryZip(SAMPLE_TEXT, { method: 0 });
    const entry = openSingleZipEntry(zip);
    expect(entry.method).toBe(0);
    expect((await readLines(entry.stream)).join('\r\n') + '\r\n').toBe(SAMPLE_TEXT);
  });

  it('reads a deflate entry using the general-purpose-bit-3 data-descriptor variant', async () => {
    // The local header's own crc/sizes are zeroed in this variant — proves
    // the reader takes sizes from the central directory, never the local one.
    const zip = buildSingleEntryZip(SAMPLE_TEXT, { method: 8, useDataDescriptor: true });
    const entry = openSingleZipEntry(zip);
    expect((await readLines(entry.stream)).join('\r\n') + '\r\n').toBe(SAMPLE_TEXT);
  });

  it('throws ZipFormatError when no End Of Central Directory record is present', () => {
    const notAZip = Buffer.from('this buffer holds no zip structure whatsoever, just text');
    expect(() => openSingleZipEntry(notAZip)).toThrow(ZipFormatError);
  });

  it('throws ZipFormatError for an unsupported compression method', () => {
    const zip = buildSingleEntryZip(SAMPLE_TEXT, { method: 8 });
    // Compression method lives at byte 10 of the central directory header;
    // corrupt it in both the local and central copies to method 99.
    const corrupted = Buffer.from(zip);
    corrupted.writeUInt16LE(99, 8); // local header method field
    const centralDirOffset = corrupted.readUInt32LE(corrupted.length - 22 + 16);
    corrupted.writeUInt16LE(99, centralDirOffset + 10);
    expect(() => openSingleZipEntry(corrupted)).toThrow(ZipFormatError);
  });

  it('throws ZipFormatError when the central directory record is missing', () => {
    const zip = buildSingleEntryZip(SAMPLE_TEXT, { method: 8 });
    // Point the EOCD's central-directory offset somewhere with no valid signature.
    const corrupted = Buffer.from(zip);
    const eocdOffset = corrupted.length - 22;
    corrupted.writeUInt32LE(0, eocdOffset + 16);
    expect(() => openSingleZipEntry(corrupted)).toThrow(ZipFormatError);
  });
});
