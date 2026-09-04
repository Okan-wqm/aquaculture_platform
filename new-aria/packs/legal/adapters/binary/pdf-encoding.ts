// PDF font decoding — from string bytes to Unicode text.
//
// WHY: a PDF string is a sequence of font-specific codes, not characters. The
// same bytes mean different letters under different fonts, and subset fonts in
// Word- or LibreOffice-produced PDFs map codes to glyph indices that carry no
// meaning without the font's /ToUnicode CMap. Decoding through the CMap when
// present and through the declared base encoding otherwise is what turns
// `<0036004B>` into "Sk" instead of noise — and a wrong decode here silently
// corrupts every date and amount the chronology is built from.
//
// WHAT: WinAnsi / MacRoman / Standard simple encodings with /Differences,
// ToUnicode CMaps (bfchar, bfrange with both forms, codespace ranges for
// 1–4 byte codes), and Identity two-byte fallback for Type0 fonts.
import type { PdfDocument, PdfDict } from './pdf-document';
import { PdfLexer } from './pdf-objects';
import type { PdfValue } from './pdf-objects';

/** Decoder for one font resource: bytes → text plus the code widths it consumed. */
export interface FontDecoder {
  readonly decode: (bytes: Buffer) => string;
}

// --- Simple encodings ------------------------------------------------------

/** WinAnsiEncoding differences from Latin-1 in the 0x80–0x9F window (ISO 32000-1 Annex D). */
const WIN_ANSI_HIGH: Readonly<Record<number, string>> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
  0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘',
  0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜',
  0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ', 0xa0: ' ',
  0xad: '­',
};

/** MacRomanEncoding for 0x80–0xFF. */
const MAC_ROMAN_HIGH =
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ\u{f8ff}ÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';

/** Glyph names that appear in /Differences arrays, mapped to their characters. */
const GLYPH_NAMES: Readonly<Record<string, string>> = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'",
  quoteright: '’', quoteleft: '‘', parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',',
  hyphen: '-', minus: '−', period: '.', slash: '/', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>',
  question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_',
  grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~', bullet: '•', endash: '–',
  emdash: '—', quotedblleft: '“', quotedblright: '”', quotedblbase: '„', quotesinglbase: '‚',
  ellipsis: '…', Euro: '€', sterling: '£', section: '§', copyright: '©', registered: '®',
  degree: '°', plusminus: '±', paragraph: '¶', periodcentered: '·', guillemotleft: '«',
  guillemotright: '»', onehalf: '½', onequarter: '¼', threequarters: '¾', multiply: '×',
  divide: '÷', fi: 'ﬁ', fl: 'ﬂ', ff: 'ﬀ', ffi: 'ﬃ', ffl: 'ﬄ', nbspace: ' ',
  Aring: 'Å', aring: 'å', AE: 'Æ', ae: 'æ', Oslash: 'Ø', oslash: 'ø', Adieresis: 'Ä', adieresis: 'ä', Odieresis: 'Ö',
  odieresis: 'ö', Udieresis: 'Ü', udieresis: 'ü', germandbls: 'ß', Eacute: 'É', eacute: 'é', Egrave: 'È', egrave: 'è',
  Aacute: 'Á', aacute: 'á', Agrave: 'À', agrave: 'à', Ccedilla: 'Ç', ccedilla: 'ç', Ntilde: 'Ñ', ntilde: 'ñ',
  Scaron: 'Š', scaron: 'š', Zcaron: 'Ž', zcaron: 'ž', Idotaccent: 'İ', dotlessi: 'ı', Gbreve: 'Ğ', gbreve: 'ğ',
  Scedilla: 'Ş', scedilla: 'ş', Ecircumflex: 'Ê', ecircumflex: 'ê', Ocircumflex: 'Ô', ocircumflex: 'ô',
  Acircumflex: 'Â', acircumflex: 'â', Icircumflex: 'Î', icircumflex: 'î', Ucircumflex: 'Û', ucircumflex: 'û',
  Iacute: 'Í', iacute: 'í', Oacute: 'Ó', oacute: 'ó', Uacute: 'Ú', uacute: 'ú', Otilde: 'Õ', otilde: 'õ', Atilde: 'Ã',
  atilde: 'ã', Edieresis: 'Ë', edieresis: 'ë', Idieresis: 'Ï', idieresis: 'ï', ydieresis: 'ÿ', Ydieresis: 'Ÿ',
  Igrave: 'Ì', igrave: 'ì', Ograve: 'Ò', ograve: 'ò', Ugrave: 'Ù', ugrave: 'ù', Thorn: 'Þ', thorn: 'þ', Eth: 'Ð',
  eth: 'ð', trademark: '™', dagger: '†', daggerdbl: '‡', perthousand: '‰', fraction: '⁄',
  currency: '¤', yen: '¥', cent: '¢', brokenbar: '¦', dieresis: '¨', ordfeminine: 'ª',
  logicalnot: '¬', macron: '¯', acute: '´', mu: 'µ', cedilla: '¸', onesuperior: '¹',
  twosuperior: '²', threesuperior: '³', ordmasculine: 'º', questiondown: '¿', exclamdown: '¡',
};

function glyphToChar(name: string): string | null {
  const known = GLYPH_NAMES[name];
  if (known !== undefined) return known;
  if (name.length === 1) return name;
  const uni = /^uni([0-9A-Fa-f]{4})/.exec(name);
  if (uni !== null) return String.fromCodePoint(parseInt(uni[1] as string, 16));
  const u = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (u !== null) return String.fromCodePoint(parseInt(u[1] as string, 16));
  const gxx = /^(?:g|cid|c|G)(\d+)$/.exec(name);
  if (gxx !== null) return null;
  return null;
}

function baseTable(encodingName: string | null): string[] {
  const table: string[] = new Array<string>(256);
  for (let code = 0; code < 256; code += 1) {
    if (encodingName === 'MacRomanEncoding' && code >= 0x80) {
      table[code] = [...MAC_ROMAN_HIGH][code - 0x80] ?? '';
    } else if (encodingName === 'WinAnsiEncoding' && code >= 0x80 && code <= 0xad) {
      table[code] = WIN_ANSI_HIGH[code] ?? String.fromCharCode(code);
    } else {
      table[code] = String.fromCharCode(code);
    }
  }
  return table;
}

function simpleDecoder(doc: PdfDocument, font: PdfDict): FontDecoder {
  const encoding = doc.resolve(font.get('Encoding'));
  let encodingName: string | null = null;
  let differences: PdfValue | undefined;
  if (encoding.type === 'name') encodingName = encoding.name;
  else if (encoding.type === 'dict') {
    const base = doc.resolve(encoding.entries.get('BaseEncoding'));
    if (base.type === 'name') encodingName = base.name;
    differences = doc.resolve(encoding.entries.get('Differences'));
  }
  const table = baseTable(encodingName);
  if (differences !== undefined && differences.type === 'array') {
    let code = 0;
    for (const item of differences.items) {
      const value = doc.resolve(item);
      if (value.type === 'number') code = Math.floor(value.value);
      else if (value.type === 'name') {
        if (code >= 0 && code < 256) {
          const char = glyphToChar(value.name);
          if (char !== null) table[code] = char;
        }
        code += 1;
      }
    }
  }
  return {
    decode: (bytes) => {
      let out = '';
      for (const byte of bytes) out += table[byte] ?? '';
      return out;
    },
  };
}

// --- ToUnicode CMaps -------------------------------------------------------

interface CodespaceRange {
  readonly byteLength: number;
  readonly low: number;
  readonly high: number;
}

interface CMap {
  readonly codespaces: readonly CodespaceRange[];
  readonly single: ReadonlyMap<number, string>;
  readonly ranges: readonly { readonly byteLength: number; readonly low: number; readonly high: number; readonly dst: string; readonly dstList: readonly string[] | null }[];
}

function bytesToNumber(bytes: Buffer): number {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
}

function utf16beToString(bytes: Buffer): string {
  if (bytes.length % 2 === 1) return bytes.toString('latin1');
  const units: number[] = [];
  for (let index = 0; index + 1 < bytes.length; index += 2) units.push(((bytes[index] as number) << 8) | (bytes[index + 1] as number));
  return String.fromCharCode(...units);
}

/** Parses the subset of CMap syntax that ToUnicode streams use. */
export function parseToUnicode(body: Buffer): CMap {
  const lexer = new PdfLexer(body);
  const codespaces: CodespaceRange[] = [];
  const single = new Map<number, string>();
  const ranges: { byteLength: number; low: number; high: number; dst: string; dstList: readonly string[] | null }[] = [];
  const readValues = (until: string): PdfValue[] => {
    const values: PdfValue[] = [];
    for (;;) {
      const next = lexer.peekToken();
      if (next === null || next === until) {
        lexer.readToken();
        break;
      }
      const value = lexer.parseValue(false);
      if (value === null) {
        lexer.readToken();
        continue;
      }
      values.push(value);
      if (values.length > 200_000) break;
    }
    return values;
  };
  let guard = 0;
  for (;;) {
    guard += 1;
    if (guard > 1_000_000) break;
    const token = lexer.readToken();
    if (token === null) break;
    if (token === 'begincodespacerange') {
      const values = readValues('endcodespacerange');
      for (let index = 0; index + 1 < values.length; index += 2) {
        const low = values[index];
        const high = values[index + 1];
        if (low?.type === 'string' && high?.type === 'string') {
          codespaces.push({ byteLength: low.bytes.length, low: bytesToNumber(low.bytes), high: bytesToNumber(high.bytes) });
        }
      }
    } else if (token === 'beginbfchar') {
      const values = readValues('endbfchar');
      for (let index = 0; index + 1 < values.length; index += 2) {
        const src = values[index];
        const dst = values[index + 1];
        if (src?.type === 'string' && dst?.type === 'string') {
          single.set(bytesToNumber(src.bytes), utf16beToString(dst.bytes));
          if (!codespaces.some((range) => range.byteLength === src.bytes.length)) {
            codespaces.push({ byteLength: src.bytes.length, low: 0, high: 256 ** src.bytes.length - 1 });
          }
        } else if (src?.type === 'string' && dst?.type === 'name') {
          const char = glyphToChar(dst.name);
          if (char !== null) single.set(bytesToNumber(src.bytes), char);
        }
      }
    } else if (token === 'beginbfrange') {
      const values = readValues('endbfrange');
      for (let index = 0; index + 2 < values.length; index += 3) {
        const low = values[index];
        const high = values[index + 1];
        const dst = values[index + 2];
        if (low?.type !== 'string' || high?.type !== 'string') continue;
        const byteLength = low.bytes.length;
        if (!codespaces.some((range) => range.byteLength === byteLength)) {
          codespaces.push({ byteLength, low: 0, high: 256 ** byteLength - 1 });
        }
        if (dst?.type === 'string') {
          ranges.push({ byteLength, low: bytesToNumber(low.bytes), high: bytesToNumber(high.bytes), dst: utf16beToString(dst.bytes), dstList: null });
        } else if (dst?.type === 'array') {
          const list = dst.items.map((item) => (item.type === 'string' ? utf16beToString(item.bytes) : ''));
          ranges.push({ byteLength, low: bytesToNumber(low.bytes), high: bytesToNumber(high.bytes), dst: '', dstList: list });
        }
      }
    }
  }
  if (codespaces.length === 0) codespaces.push({ byteLength: 1, low: 0, high: 255 });
  return { codespaces, single, ranges };
}

function incrementLast(text: string, delta: number): string {
  if (text.length === 0) return '';
  const last = text.codePointAt(text.length - 1) ?? 0;
  return text.slice(0, -1) + String.fromCodePoint(last + delta);
}

function cmapDecoder(cmap: CMap, fallbackTwoByte: boolean): FontDecoder {
  const lengths = [...new Set(cmap.codespaces.map((range) => range.byteLength))].sort((a, b) => a - b);
  return {
    decode: (bytes) => {
      let out = '';
      let index = 0;
      while (index < bytes.length) {
        let matched = false;
        for (const length of lengths) {
          if (index + length > bytes.length) continue;
          const code = bytesToNumber(bytes.subarray(index, index + length));
          const inSpace = cmap.codespaces.some((range) => range.byteLength === length && code >= range.low && code <= range.high);
          if (!inSpace) continue;
          const direct = cmap.single.get(code);
          if (direct !== undefined) {
            out += direct;
          } else {
            const range = cmap.ranges.find((candidate) => candidate.byteLength === length && code >= candidate.low && code <= candidate.high);
            if (range !== undefined) {
              out += range.dstList !== null ? (range.dstList[code - range.low] ?? '') : incrementLast(range.dst, code - range.low);
            } else if (length === 1 && !fallbackTwoByte) {
              out += String.fromCharCode(code);
            }
          }
          index += length;
          matched = true;
          break;
        }
        if (!matched) {
          const width = fallbackTwoByte ? 2 : 1;
          const code = bytesToNumber(bytes.subarray(index, index + width));
          const direct = cmap.single.get(code);
          out += direct ?? (fallbackTwoByte ? '' : String.fromCharCode(code));
          index += width;
        }
      }
      return out;
    },
  };
}

/** Builds the decoder for a font dictionary, preferring /ToUnicode over any base encoding. */
export function fontDecoder(doc: PdfDocument, font: PdfDict): FontDecoder {
  const subtype = doc.resolve(font.get('Subtype'));
  const isType0 = subtype.type === 'name' && subtype.name === 'Type0';
  const toUnicode = doc.decoded(font.get('ToUnicode'));
  if (toUnicode !== null) {
    return cmapDecoder(parseToUnicode(toUnicode), isType0);
  }
  if (isType0) {
    // Identity-H without ToUnicode: the codes are glyph ids and carry no
    // recoverable text. Emitting nothing is the honest outcome.
    return { decode: () => '' };
  }
  return simpleDecoder(doc, font);
}
