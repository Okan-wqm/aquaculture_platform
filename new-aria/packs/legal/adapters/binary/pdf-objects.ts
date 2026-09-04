// PDF object layer — lexer, object graph and stream decoding (packs/legal).
//
// WHY: a legal archive is mostly PDF. A document whose text ARIA cannot read is
// a document whose dates never reach the chronology and whose amounts never
// reach the loss record — the case is then built on a partial corpus without
// anyone being told. Reading PDF text is therefore a floor capability of the
// pack, not a convenience. It is implemented here from the file format itself
// rather than through a third-party library because a legal evidence tool must
// be deterministic, offline, auditable line by line, and free of a supply-chain
// surface that could alter what a court-facing archive says (pack Law L3: no
// network, no LLM, no side effects).
//
// WHAT: enough of ISO 32000-1 to reach the text: the tokenizer, the object
// dictionary/array/name/string/number grammar, indirect-object scanning that
// does not depend on a healthy cross-reference table, FlateDecode with the PNG
// and TIFF predictors, and object streams (/Type /ObjStm) which modern writers
// use to hold most of the document catalogue.
//
// NOT here: decryption. An encrypted PDF is reported as such and inventoried
// metadata_only; guessing at a password would be a legal risk, not a feature.
import { inflateSync, unzipSync } from 'node:zlib';

/** Any value the object grammar can carry. */
export type PdfValue =
  | { readonly type: 'null' }
  | { readonly type: 'bool'; readonly value: boolean }
  | { readonly type: 'number'; readonly value: number }
  | { readonly type: 'string'; readonly bytes: Buffer }
  | { readonly type: 'name'; readonly name: string }
  | { readonly type: 'array'; readonly items: readonly PdfValue[] }
  | { readonly type: 'dict'; readonly entries: ReadonlyMap<string, PdfValue> }
  | { readonly type: 'stream'; readonly dict: ReadonlyMap<string, PdfValue>; readonly raw: Buffer }
  | { readonly type: 'ref'; readonly num: number; readonly gen: number };

export const PDF_NULL: PdfValue = { type: 'null' };

/** Bytes that end a token in PDF syntax. */
const DELIMITERS = new Set<number>([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

function isWhitespace(byte: number): boolean {
  return byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20;
}

function isRegular(byte: number): boolean {
  return !isWhitespace(byte) && !DELIMITERS.has(byte);
}

/**
 * Cursor over a byte range. Every parse step is bounded by `end`, so a truncated
 * or malformed file yields a short read rather than an unbounded loop.
 */
export class PdfLexer {
  private position: number;

  constructor(
    private readonly bytes: Buffer,
    start = 0,
    private readonly end = bytes.length,
  ) {
    this.position = start;
  }

  get offset(): number {
    return this.position;
  }

  set offset(next: number) {
    this.position = Math.max(0, Math.min(next, this.end));
  }

  atEnd(): boolean {
    return this.position >= this.end;
  }

  /** Skips whitespace and `%` comments, which may appear between any two tokens. */
  skipTrivia(): void {
    while (this.position < this.end) {
      const byte = this.bytes[this.position] as number;
      if (isWhitespace(byte)) {
        this.position += 1;
        continue;
      }
      if (byte === 0x25) {
        while (this.position < this.end && this.bytes[this.position] !== 0x0a && this.bytes[this.position] !== 0x0d) {
          this.position += 1;
        }
        continue;
      }
      return;
    }
  }

  /** Reads the next bare token (keyword, number, or a single delimiter run). */
  readToken(): string | null {
    this.skipTrivia();
    if (this.position >= this.end) return null;
    const byte = this.bytes[this.position] as number;
    if (byte === 0x3c && this.bytes[this.position + 1] === 0x3c) {
      this.position += 2;
      return '<<';
    }
    if (byte === 0x3e && this.bytes[this.position + 1] === 0x3e) {
      this.position += 2;
      return '>>';
    }
    if (DELIMITERS.has(byte)) {
      this.position += 1;
      return String.fromCharCode(byte);
    }
    const start = this.position;
    while (this.position < this.end && isRegular(this.bytes[this.position] as number)) {
      this.position += 1;
    }
    if (this.position === start) {
      this.position += 1;
      return String.fromCharCode(byte);
    }
    return this.bytes.toString('latin1', start, this.position);
  }

  /** Looks at the next token without consuming it. */
  peekToken(): string | null {
    const saved = this.position;
    const token = this.readToken();
    this.position = saved;
    return token;
  }

  /** Reads a name after the `/` delimiter has been consumed, resolving `#xx` escapes. */
  readNameBody(): string {
    const start = this.position;
    while (this.position < this.end && isRegular(this.bytes[this.position] as number)) {
      this.position += 1;
    }
    const raw = this.bytes.toString('latin1', start, this.position);
    return raw.replace(/#([0-9a-fA-F]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }

  /** Reads a literal `(...)` string, honouring nesting and backslash escapes. */
  readLiteralString(): Buffer {
    const out: number[] = [];
    let depth = 1;
    while (this.position < this.end) {
      const byte = this.bytes[this.position] as number;
      this.position += 1;
      if (byte === 0x5c) {
        if (this.position >= this.end) break;
        const escaped = this.bytes[this.position] as number;
        this.position += 1;
        if (escaped === 0x6e) out.push(0x0a);
        else if (escaped === 0x72) out.push(0x0d);
        else if (escaped === 0x74) out.push(0x09);
        else if (escaped === 0x62) out.push(0x08);
        else if (escaped === 0x66) out.push(0x0c);
        else if (escaped >= 0x30 && escaped <= 0x37) {
          let code = escaped - 0x30;
          for (let digit = 0; digit < 2; digit += 1) {
            const next = this.bytes[this.position];
            if (next === undefined || next < 0x30 || next > 0x37) break;
            code = code * 8 + (next - 0x30);
            this.position += 1;
          }
          out.push(code & 0xff);
        } else if (escaped === 0x0a) {
          // Line continuation: the escaped newline contributes nothing.
        } else if (escaped === 0x0d) {
          if (this.bytes[this.position] === 0x0a) this.position += 1;
        } else {
          out.push(escaped);
        }
        continue;
      }
      if (byte === 0x28) {
        depth += 1;
        out.push(byte);
        continue;
      }
      if (byte === 0x29) {
        depth -= 1;
        if (depth === 0) break;
        out.push(byte);
        continue;
      }
      out.push(byte);
    }
    return Buffer.from(out);
  }

  /** Reads a hex `<...>` string; an odd final digit is padded with 0 per the spec. */
  readHexString(): Buffer {
    const digits: string[] = [];
    while (this.position < this.end) {
      const byte = this.bytes[this.position] as number;
      this.position += 1;
      if (byte === 0x3e) break;
      const char = String.fromCharCode(byte);
      if (/[0-9a-fA-F]/.test(char)) digits.push(char);
    }
    if (digits.length % 2 === 1) digits.push('0');
    const out = Buffer.alloc(digits.length / 2);
    for (let index = 0; index < out.length; index += 1) {
      out[index] = parseInt(`${digits[index * 2]}${digits[index * 2 + 1]}`, 16);
    }
    return out;
  }

  /**
   * Parses one object. `allowStream` is false inside content streams, where the
   * `stream` keyword cannot appear and treating it as one would swallow operators.
   */
  parseValue(allowStream: boolean): PdfValue | null {
    this.skipTrivia();
    if (this.position >= this.end) return null;
    const byte = this.bytes[this.position] as number;

    if (byte === 0x2f) {
      this.position += 1;
      return { type: 'name', name: this.readNameBody() };
    }
    if (byte === 0x28) {
      this.position += 1;
      return { type: 'string', bytes: this.readLiteralString() };
    }
    if (byte === 0x3c && this.bytes[this.position + 1] !== 0x3c) {
      this.position += 1;
      return { type: 'string', bytes: this.readHexString() };
    }
    if (byte === 0x5b) {
      this.position += 1;
      const items: PdfValue[] = [];
      for (;;) {
        this.skipTrivia();
        if (this.position >= this.end) break;
        if (this.bytes[this.position] === 0x5d) {
          this.position += 1;
          break;
        }
        const item = this.parseValue(false);
        if (item === null) break;
        items.push(item);
      }
      return { type: 'array', items };
    }
    if (byte === 0x3c && this.bytes[this.position + 1] === 0x3c) {
      this.position += 2;
      const entries = new Map<string, PdfValue>();
      for (;;) {
        this.skipTrivia();
        if (this.position >= this.end) break;
        if (this.bytes[this.position] === 0x3e && this.bytes[this.position + 1] === 0x3e) {
          this.position += 2;
          break;
        }
        if (this.bytes[this.position] !== 0x2f) {
          // A malformed dictionary body: step over one byte and keep looking for
          // the closing marker rather than abandoning the whole object.
          this.position += 1;
          continue;
        }
        this.position += 1;
        const key = this.readNameBody();
        const value = this.parseValue(false);
        if (value === null) break;
        entries.set(key, value);
      }
      if (allowStream) {
        const saved = this.position;
        const token = this.readToken();
        if (token === 'stream') {
          if (this.bytes[this.position] === 0x0d) this.position += 1;
          if (this.bytes[this.position] === 0x0a) this.position += 1;
          const raw = this.readStreamBody(entries);
          return { type: 'stream', dict: entries, raw };
        }
        this.position = saved;
      }
      return { type: 'dict', entries };
    }

    const token = this.readToken();
    if (token === null) return null;
    if (token === 'true') return { type: 'bool', value: true };
    if (token === 'false') return { type: 'bool', value: false };
    if (token === 'null') return PDF_NULL;
    if (/^[+-]?[\d.]+$/.test(token)) {
      const saved = this.position;
      const second = this.readToken();
      if (second !== null && /^\d+$/.test(second)) {
        const third = this.readToken();
        if (third === 'R') {
          return { type: 'ref', num: Number(token), gen: Number(second) };
        }
      }
      this.position = saved;
      const numeric = Number(token);
      return { type: 'number', value: Number.isFinite(numeric) ? numeric : 0 };
    }
    return null;
  }

  /**
   * Reads a stream body. `/Length` is trusted only when it lands on `endstream`;
   * otherwise the terminator is searched for, because a wrong Length is one of
   * the most common defects in real-world files.
   */
  private readStreamBody(dict: ReadonlyMap<string, PdfValue>): Buffer {
    const start = this.position;
    const declared = dict.get('Length');
    if (declared !== undefined && declared.type === 'number') {
      const end = start + declared.value;
      if (end <= this.end && end >= start) {
        const probe = new PdfLexer(this.bytes, end, Math.min(this.end, end + 32));
        if (probe.readToken() === 'endstream') {
          this.position = end;
          this.readToken();
          return this.bytes.subarray(start, end);
        }
      }
    }
    const marker = this.bytes.indexOf('endstream', start, 'latin1');
    const end = marker === -1 || marker > this.end ? this.end : marker;
    let trimmed = end;
    if (this.bytes[trimmed - 1] === 0x0a) trimmed -= 1;
    if (this.bytes[trimmed - 1] === 0x0d) trimmed -= 1;
    this.position = Math.min(this.end, end + 'endstream'.length);
    return this.bytes.subarray(start, Math.max(start, trimmed));
  }
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** Undoes the PNG/TIFF predictors that /DecodeParms may declare after FlateDecode. */
function undoPredictor(data: Buffer, parms: ReadonlyMap<string, PdfValue> | null): Buffer {
  if (parms === null) return data;
  const predictorValue = parms.get('Predictor');
  const predictor = predictorValue !== undefined && predictorValue.type === 'number' ? predictorValue.value : 1;
  if (predictor <= 1) return data;
  const columnsValue = parms.get('Columns');
  const colorsValue = parms.get('Colors');
  const bpcValue = parms.get('BitsPerComponent');
  const columns = columnsValue !== undefined && columnsValue.type === 'number' ? columnsValue.value : 1;
  const colors = colorsValue !== undefined && colorsValue.type === 'number' ? colorsValue.value : 1;
  const bitsPerComponent = bpcValue !== undefined && bpcValue.type === 'number' ? bpcValue.value : 8;
  const bytesPerPixel = Math.max(1, Math.ceil((colors * bitsPerComponent) / 8));
  const rowLength = Math.ceil((columns * colors * bitsPerComponent) / 8);
  if (predictor === 2) {
    if (bitsPerComponent !== 8) return data;
    const out = Buffer.from(data);
    for (let row = 0; row + rowLength <= out.length; row += rowLength) {
      for (let index = bytesPerPixel; index < rowLength; index += 1) {
        out[row + index] = (out[row + index] + out[row + index - bytesPerPixel]) & 0xff;
      }
    }
    return out;
  }
  // PNG predictors: each row is prefixed with a filter-type byte.
  const stride = rowLength + 1;
  const rows = Math.floor(data.length / stride);
  const out = Buffer.alloc(rows * rowLength);
  let previous = Buffer.alloc(rowLength);
  for (let row = 0; row < rows; row += 1) {
    const filter = data[row * stride] as number;
    const source = data.subarray(row * stride + 1, row * stride + 1 + rowLength);
    const current = Buffer.alloc(rowLength);
    for (let index = 0; index < rowLength; index += 1) {
      const raw = source[index] ?? 0;
      const left = index >= bytesPerPixel ? (current[index - bytesPerPixel] as number) : 0;
      const up = previous[index] as number;
      const upLeft = index >= bytesPerPixel ? (previous[index - bytesPerPixel] as number) : 0;
      let value = raw;
      if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
      current[index] = value & 0xff;
    }
    current.copy(out, row * rowLength);
    previous = current;
  }
  return out;
}

/** Expands ASCIIHexDecode, which some writers use for small streams. */
function asciiHexDecode(data: Buffer): Buffer {
  const text = data.toString('latin1');
  const end = text.indexOf('>');
  const digits = (end === -1 ? text : text.slice(0, end)).replace(/[^0-9a-fA-F]/g, '');
  const padded = digits.length % 2 === 1 ? `${digits}0` : digits;
  return Buffer.from(padded, 'hex');
}

/** Expands ASCII85Decode. */
function ascii85Decode(data: Buffer): Buffer {
  const text = data.toString('latin1').replace(/\s/g, '');
  const body = text.startsWith('<~') ? text.slice(2) : text;
  const end = body.indexOf('~>');
  const payload = end === -1 ? body : body.slice(0, end);
  const out: number[] = [];
  let group: number[] = [];
  for (const char of payload) {
    if (char === 'z' && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const code = char.charCodeAt(0) - 33;
    if (code < 0 || code > 84) continue;
    group.push(code);
    if (group.length === 5) {
      let value = 0;
      for (const digit of group) value = value * 85 + digit;
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
      group = [];
    }
  }
  if (group.length > 1) {
    const missing = 5 - group.length;
    for (let index = 0; index < missing; index += 1) group.push(84);
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    out.push(...bytes.slice(0, 4 - missing));
  }
  return Buffer.from(out);
}

/** Undoes RunLengthDecode. */
function runLengthDecode(data: Buffer): Buffer {
  const out: number[] = [];
  let index = 0;
  while (index < data.length) {
    const length = data[index] as number;
    index += 1;
    if (length === 128) break;
    if (length < 128) {
      for (let count = 0; count <= length; count += 1) {
        if (index < data.length) out.push(data[index] as number);
        index += 1;
      }
      continue;
    }
    const byte = data[index] as number;
    index += 1;
    for (let count = 0; count < 257 - length; count += 1) out.push(byte);
  }
  return Buffer.from(out);
}

function filterNames(dict: ReadonlyMap<string, PdfValue>): readonly string[] {
  const filter = dict.get('Filter') ?? dict.get('F');
  if (filter === undefined) return [];
  if (filter.type === 'name') return [filter.name];
  if (filter.type === 'array') return filter.items.filter((item): item is Extract<PdfValue, { type: 'name' }> => item.type === 'name').map((item) => item.name);
  return [];
}

function decodeParmsAt(dict: ReadonlyMap<string, PdfValue>, index: number): ReadonlyMap<string, PdfValue> | null {
  const parms = dict.get('DecodeParms') ?? dict.get('DP');
  if (parms === undefined) return null;
  if (parms.type === 'dict') return index === 0 ? parms.entries : null;
  if (parms.type === 'array') {
    const item = parms.items[index];
    return item !== undefined && item.type === 'dict' ? item.entries : null;
  }
  return null;
}

/**
 * Applies a stream's declared filter chain. An unsupported or failing filter
 * yields null: the caller then reports the document as unreadable for a stated
 * reason rather than inventing text from bytes it did not decode.
 */
export function decodeStream(stream: Extract<PdfValue, { type: 'stream' }>): Buffer | null {
  let data = stream.raw;
  const filters = filterNames(stream.dict);
  for (let index = 0; index < filters.length; index += 1) {
    const name = filters[index] as string;
    try {
      if (name === 'FlateDecode' || name === 'Fl') {
        // Some writers emit a raw deflate body or leading whitespace; unzipSync
        // accepts both zlib and gzip wrappers, and the raw retry covers the rest.
        let inflated: Buffer;
        try {
          inflated = unzipSync(data);
        } catch {
          inflated = inflateSync(data, { finishFlush: 2 });
        }
        data = undoPredictor(inflated, decodeParmsAt(stream.dict, index));
      } else if (name === 'ASCIIHexDecode' || name === 'AHx') {
        data = asciiHexDecode(data);
      } else if (name === 'ASCII85Decode' || name === 'A85') {
        data = ascii85Decode(data);
      } else if (name === 'RunLengthDecode' || name === 'RL') {
        data = runLengthDecode(data);
      } else if (name === 'Crypt') {
        continue;
      } else {
        // DCTDecode / JPXDecode / CCITTFaxDecode are image codecs: there is no
        // text under them, and claiming otherwise would be a fabrication.
        return null;
      }
    } catch {
      return null;
    }
  }
  return data;
}
