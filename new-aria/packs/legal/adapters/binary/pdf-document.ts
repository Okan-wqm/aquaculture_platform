// PDF document graph — indirect objects, object streams and the page tree.
//
// WHY: the cross-reference table is the part of a PDF most often damaged by
// incremental saves, e-mail gateways and "print to PDF" drivers. Text
// extraction that trusts the xref reads nothing from such files. Scanning the
// bytes for `N G obj` markers and honouring the LAST definition of each object
// number (which is exactly what an incremental update means) recovers the same
// object graph without depending on the table, and object streams are expanded
// so that catalogues written by modern producers are visible too.
//
// WHAT: `loadPdfDocument(bytes)` → resolver over the object graph plus the
// ordered list of page objects. Every lookup is bounded; reference cycles are
// cut by a visited set.
import type { PdfValue } from './pdf-objects';
import { decodeStream, PDF_NULL, PdfLexer } from './pdf-objects';

export type PdfDict = ReadonlyMap<string, PdfValue>;
export type PdfStream = Extract<PdfValue, { type: 'stream' }>;

/** Upper bounds that keep a hostile file from turning into a CPU sink. */
export const PDF_LIMITS = {
  maxObjects: 250_000,
  maxPages: 5_000,
  maxObjectStreamBytes: 64 * 1024 * 1024,
} as const;

interface ObjectSlot {
  readonly offset: number;
  readonly gen: number;
}

export interface PdfDocument {
  readonly encrypted: boolean;
  readonly objectCount: number;
  readonly pages: readonly PdfDict[];
  resolve(value: PdfValue | undefined): PdfValue;
  dictOf(value: PdfValue | undefined): PdfDict | null;
  streamOf(value: PdfValue | undefined): PdfStream | null;
  decoded(value: PdfValue | undefined): Buffer | null;
}

const OBJ_MARKER = /(\d+)\s+(\d+)\s+obj\b/g;

/** Locates every `N G obj` header. Later definitions win, mirroring incremental updates. */
function scanObjectOffsets(bytes: Buffer): Map<number, ObjectSlot> {
  const slots = new Map<number, ObjectSlot>();
  const text = bytes.toString('latin1');
  OBJ_MARKER.lastIndex = 0;
  let match: RegExpExecArray | null;
  let seen = 0;
  while ((match = OBJ_MARKER.exec(text)) !== null) {
    seen += 1;
    if (seen > PDF_LIMITS.maxObjects) break;
    const num = Number(match[1]);
    const gen = Number(match[2]);
    // The marker must begin a token: a digit directly before it means this is
    // the tail of a larger number inside a stream, not an object header.
    const before = match.index === 0 ? 0x20 : text.charCodeAt(match.index - 1);
    if (before >= 0x30 && before <= 0x39) continue;
    slots.set(num, { offset: match.index + match[0].length, gen });
  }
  return slots;
}

function parseObjectAt(bytes: Buffer, offset: number): PdfValue {
  const lexer = new PdfLexer(bytes, offset);
  const value = lexer.parseValue(true);
  return value ?? PDF_NULL;
}

/**
 * Expands one /Type /ObjStm stream into (objectNumber → value) pairs. Objects
 * already defined directly in the file are not overridden: a direct definition
 * that appears after the stream is an incremental update and must win.
 */
function expandObjectStream(stream: PdfStream, into: Map<number, PdfValue>, direct: ReadonlySet<number>): void {
  const body = decodeStream(stream);
  if (body === null || body.length > PDF_LIMITS.maxObjectStreamBytes) return;
  const countValue = stream.dict.get('N');
  const firstValue = stream.dict.get('First');
  if (countValue === undefined || countValue.type !== 'number' || firstValue === undefined || firstValue.type !== 'number') return;
  const header = new PdfLexer(body, 0, Math.min(body.length, firstValue.value));
  const pairs: { num: number; offset: number }[] = [];
  for (let index = 0; index < countValue.value; index += 1) {
    const numToken = header.readToken();
    const offsetToken = header.readToken();
    if (numToken === null || offsetToken === null) break;
    const num = Number(numToken);
    const offset = Number(offsetToken);
    if (!Number.isInteger(num) || !Number.isInteger(offset)) break;
    pairs.push({ num, offset });
  }
  for (const pair of pairs) {
    if (direct.has(pair.num)) continue;
    const start = firstValue.value + pair.offset;
    if (start < 0 || start >= body.length) continue;
    const lexer = new PdfLexer(body, start);
    const value = lexer.parseValue(false);
    if (value !== null) into.set(pair.num, value);
  }
}

/** Reads the trailer dictionaries (classic and xref-stream) only to learn whether the file is encrypted. */
function detectEncryption(bytes: Buffer, resolveDict: (value: PdfValue | undefined) => PdfDict | null): boolean {
  const text = bytes.toString('latin1');
  let cursor = text.lastIndexOf('trailer');
  while (cursor !== -1) {
    const lexer = new PdfLexer(bytes, cursor + 'trailer'.length);
    const trailer = lexer.parseValue(false);
    if (trailer !== null && trailer.type === 'dict' && trailer.entries.has('Encrypt')) return true;
    cursor = text.lastIndexOf('trailer', cursor - 1);
  }
  // Cross-reference streams carry the trailer keys on the stream dictionary.
  return /\/Type\s*\/XRef[\s\S]{0,400}?\/Encrypt\b/.test(text) && resolveDict !== null;
}

export function loadPdfDocument(bytes: Buffer): PdfDocument {
  const slots = scanObjectOffsets(bytes);
  const cache = new Map<number, PdfValue>();
  const direct = new Set(slots.keys());

  const objectAt = (num: number): PdfValue => {
    const cached = cache.get(num);
    if (cached !== undefined) return cached;
    const slot = slots.get(num);
    const value = slot === undefined ? PDF_NULL : parseObjectAt(bytes, slot.offset);
    cache.set(num, value);
    return value;
  };

  // Object streams must be expanded before any lookup that could land on a
  // compressed object; a two-pass approach keeps this deterministic.
  for (const num of slots.keys()) {
    const value = objectAt(num);
    if (value.type === 'stream') {
      const type = value.dict.get('Type');
      if (type !== undefined && type.type === 'name' && type.name === 'ObjStm') {
        expandObjectStream(value, cache, direct);
      }
    }
  }

  const resolve = (value: PdfValue | undefined, depth = 0): PdfValue => {
    let current = value ?? PDF_NULL;
    const visited = new Set<number>();
    while (current.type === 'ref') {
      if (visited.has(current.num) || visited.size > 64 || depth > 64) return PDF_NULL;
      visited.add(current.num);
      current = cache.get(current.num) ?? objectAt(current.num);
    }
    return current;
  };
  const dictOf = (value: PdfValue | undefined): PdfDict | null => {
    const resolved = resolve(value);
    if (resolved.type === 'dict') return resolved.entries;
    if (resolved.type === 'stream') return resolved.dict;
    return null;
  };
  const streamOf = (value: PdfValue | undefined): PdfStream | null => {
    const resolved = resolve(value);
    return resolved.type === 'stream' ? resolved : null;
  };
  const decoded = (value: PdfValue | undefined): Buffer | null => {
    const stream = streamOf(value);
    return stream === null ? null : decodeStream(stream);
  };

  const pages: PdfDict[] = [];
  const visitedPages = new Set<PdfDict>();
  const walkPageTree = (node: PdfDict | null, depth: number): void => {
    if (node === null || visitedPages.has(node) || depth > 64 || pages.length >= PDF_LIMITS.maxPages) return;
    visitedPages.add(node);
    const type = resolve(node.get('Type'));
    const kids = resolve(node.get('Kids'));
    if (type.type === 'name' && type.name === 'Page') {
      pages.push(node);
      return;
    }
    if (kids.type === 'array') {
      for (const kid of kids.items) walkPageTree(dictOf(kid), depth + 1);
      return;
    }
    // Some producers omit /Type on leaf pages; a node with /Contents is a page.
    if (node.has('Contents')) pages.push(node);
  };

  // Prefer the catalogue's page tree (correct reading order); fall back to a
  // scan of every /Type /Page object sorted by object number when the tree is
  // missing or broken, so a damaged file still yields its text.
  let catalogPages: PdfDict | null = null;
  for (const [num] of slots) {
    const value = resolve(cache.get(num) ?? objectAt(num));
    const dict = value.type === 'dict' ? value.entries : value.type === 'stream' ? value.dict : null;
    if (dict === null) continue;
    const type = resolve(dict.get('Type'));
    if (type.type === 'name' && type.name === 'Catalog') {
      const rootPages = dictOf(dict.get('Pages'));
      if (rootPages !== null) catalogPages = rootPages;
    }
  }
  walkPageTree(catalogPages, 0);
  if (pages.length === 0) {
    const numbers = [...new Set([...slots.keys(), ...cache.keys()])].sort((a, b) => a - b);
    for (const num of numbers) {
      const value = resolve(cache.get(num) ?? objectAt(num));
      const dict = value.type === 'dict' ? value.entries : null;
      if (dict === null) continue;
      const type = resolve(dict.get('Type'));
      if (type.type === 'name' && type.name === 'Page' && !visitedPages.has(dict)) {
        visitedPages.add(dict);
        pages.push(dict);
        if (pages.length >= PDF_LIMITS.maxPages) break;
      }
    }
  }

  return {
    encrypted: detectEncryption(bytes, dictOf),
    objectCount: slots.size + (cache.size - slots.size > 0 ? cache.size - slots.size : 0),
    pages,
    resolve: (value) => resolve(value),
    dictOf,
    streamOf,
    decoded,
  };
}
