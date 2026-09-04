// Office Open XML text extraction — DOCX, XLSX and PPTX without dependencies.
//
// WHY: Word is the other half of a legal archive: contracts, complaints,
// pleadings, memos. A .docx is a ZIP of XML parts; reading it needs a ZIP
// central-directory walk and DEFLATE (node:zlib), both of which the runtime
// already provides. Doing it here keeps the pack deterministic, offline and
// free of a third-party parser between the archive and the record.
//
// WHAT: `readZipEntries` (central directory → entry bytes, STORED and DEFLATE
// only), `extractDocxText` (document body + headers/footers/footnotes, with
// paragraph, tab and break structure preserved), `extractXlsxText` (shared
// strings + sheet cells as tab-separated rows), `extractPptxText` (slide text
// in slide order). Everything else in the ZIP is ignored, never executed.
import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** Bounds against a zip bomb: total inflated bytes and per-entry inflated bytes. */
const MAX_TOTAL_INFLATED = 256 * 1024 * 1024;
const MAX_ENTRY_INFLATED = 64 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

/** Reads the central directory; returns null when the bytes are not a ZIP container. */
export function readZipDirectory(bytes: Buffer): readonly ZipEntry[] | null {
  if (bytes.length < 22) return null;
  // The end-of-central-directory record sits in the last 64 KiB (comment bound).
  const searchStart = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let cursor = bytes.length - 22; cursor >= searchStart; cursor -= 1) {
    if (bytes.readUInt32LE(cursor) === EOCD_SIGNATURE) {
      eocd = cursor;
      break;
    }
  }
  if (eocd === -1) return null;
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const directoryOffset = bytes.readUInt32LE(eocd + 16);
  if (directoryOffset >= bytes.length) return null;
  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < Math.min(entryCount, MAX_ENTRIES); index += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) break;
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localHeaderOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Returns an entry's inflated bytes, or null when it is absent, encrypted or uses an unsupported method. */
export function readZipEntry(bytes: Buffer, entry: ZipEntry): Buffer | null {
  const header = entry.localHeaderOffset;
  if (header + 30 > bytes.length || bytes.readUInt32LE(header) !== LOCAL_SIGNATURE) return null;
  const flags = bytes.readUInt16LE(header + 6);
  if ((flags & 0x1) !== 0) return null; // encrypted entry
  const nameLength = bytes.readUInt16LE(header + 26);
  const extraLength = bytes.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > bytes.length) return null;
  if (entry.uncompressedSize > MAX_ENTRY_INFLATED) return null;
  const compressed = bytes.subarray(start, end);
  if (entry.method === 0) return compressed;
  if (entry.method !== 8) return null;
  try {
    return inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_INFLATED });
  } catch {
    return null;
  }
}

/** Decodes the five predefined XML entities plus numeric references. */
export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripTags(xml: string): string {
  return decodeXmlEntities(xml.replace(/<[^>]*>/g, ''));
}

interface OoxmlPackage {
  readonly bytes: Buffer;
  readonly entries: readonly ZipEntry[];
  readonly budget: { remaining: number };
}

function openPackage(bytes: Buffer): OoxmlPackage | null {
  const entries = readZipDirectory(bytes);
  if (entries === null) return null;
  return { bytes, entries, budget: { remaining: MAX_TOTAL_INFLATED } };
}

function partText(pkg: OoxmlPackage, name: string): string | null {
  const entry = pkg.entries.find((candidate) => candidate.name === name);
  if (entry === undefined) return null;
  if (entry.uncompressedSize > pkg.budget.remaining) return null;
  const body = readZipEntry(pkg.bytes, entry);
  if (body === null) return null;
  pkg.budget.remaining -= body.length;
  return body.toString('utf8');
}

function partsMatching(pkg: OoxmlPackage, pattern: RegExp): readonly string[] {
  return pkg.entries
    .map((entry) => entry.name)
    .filter((name) => pattern.test(name))
    .sort((a, b) => {
      // slide2.xml must come before slide10.xml: compare the numeric suffix.
      const na = Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0);
      const nb = Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0);
      return na - nb || (a < b ? -1 : a > b ? 1 : 0);
    });
}

/** WordprocessingML body → text with paragraphs on their own lines and tabs/breaks kept. */
function wordXmlToText(xml: string): string {
  const structured = xml
    .replace(/<w:tab\s*\/>/g, '\t')
    .replace(/<w:br\s*\/>|<w:cr\s*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, '')
    .replace(/<w:delText[^>]*>[\s\S]*?<\/w:delText>/g, '');
  return stripTags(structured)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface OoxmlText {
  readonly text: string;
  /** Which parts contributed, in order, for evidence locators. */
  readonly parts: readonly string[];
}

export function extractDocxText(bytes: Buffer): OoxmlText | null {
  const pkg = openPackage(bytes);
  if (pkg === null) return null;
  const body = partText(pkg, 'word/document.xml');
  if (body === null) return null;
  const parts: string[] = ['word/document.xml'];
  const sections: string[] = [wordXmlToText(body)];
  for (const name of [
    ...partsMatching(pkg, /^word\/header\d*\.xml$/),
    ...partsMatching(pkg, /^word\/footer\d*\.xml$/),
    ...partsMatching(pkg, /^word\/footnotes\.xml$/),
    ...partsMatching(pkg, /^word\/endnotes\.xml$/),
    ...partsMatching(pkg, /^word\/comments\.xml$/),
  ]) {
    const xml = partText(pkg, name);
    if (xml === null) continue;
    const text = wordXmlToText(xml);
    if (text.length === 0) continue;
    parts.push(name);
    sections.push(text);
  }
  return { text: sections.join('\n\n').trim(), parts };
}

function sharedStrings(pkg: OoxmlPackage): readonly string[] {
  const xml = partText(pkg, 'xl/sharedStrings.xml');
  if (xml === null) return [];
  const items: string[] = [];
  const itemRe = /<si>([\s\S]*?)<\/si>/g;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) !== null) {
    const texts: string[] = [];
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let t: RegExpExecArray | null;
    while ((t = tRe.exec(match[1] as string)) !== null) texts.push(decodeXmlEntities(t[1] as string));
    items.push(texts.join(''));
  }
  return items;
}

export function extractXlsxText(bytes: Buffer): OoxmlText | null {
  const pkg = openPackage(bytes);
  if (pkg === null) return null;
  const strings = sharedStrings(pkg);
  const sheets = partsMatching(pkg, /^xl\/worksheets\/sheet\d+\.xml$/);
  if (sheets.length === 0) return null;
  const parts: string[] = [];
  const sections: string[] = [];
  for (const name of sheets) {
    const xml = partText(pkg, name);
    if (xml === null) continue;
    const rows: string[] = [];
    const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
    let row: RegExpExecArray | null;
    while ((row = rowRe.exec(xml)) !== null) {
      const cells: string[] = [];
      const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
      let cell: RegExpExecArray | null;
      while ((cell = cellRe.exec(row[1] as string)) !== null) {
        const attrs = cell[1] as string;
        const inner = cell[2] as string;
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? null;
        const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? null;
        if (type === 's' && value !== null) cells.push(strings[Number(value)] ?? '');
        else if (type === 'inlineStr') cells.push(stripTags(inner));
        else if (value !== null) cells.push(decodeXmlEntities(value));
        else cells.push('');
      }
      if (cells.some((text) => text.length > 0)) rows.push(cells.join('\t').replace(/\t+$/g, ''));
    }
    if (rows.length === 0) continue;
    parts.push(name);
    sections.push(rows.join('\n'));
  }
  return { text: sections.join('\n\n').trim(), parts };
}

export function extractPptxText(bytes: Buffer): OoxmlText | null {
  const pkg = openPackage(bytes);
  if (pkg === null) return null;
  const slides = partsMatching(pkg, /^ppt\/slides\/slide\d+\.xml$/);
  if (slides.length === 0) return null;
  const parts: string[] = [];
  const sections: string[] = [];
  for (const name of slides) {
    const xml = partText(pkg, name);
    if (xml === null) continue;
    const text = stripTags(xml.replace(/<\/a:p>/g, '\n').replace(/<a:br\s*\/>/g, '\n'))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join('\n');
    if (text.length === 0) continue;
    parts.push(name);
    sections.push(text);
  }
  return { text: sections.join('\n\n').trim(), parts };
}
