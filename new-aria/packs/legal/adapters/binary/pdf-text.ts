// PDF text extraction — page content streams to reading-order text.
//
// WHY: dates, amounts, parties and versions all come out of the words on the
// page; the chronology of a case is only as complete as the pages ARIA could
// read. This module walks each page's content stream(s), applies the fonts'
// decoders, and reconstructs lines from the text-positioning operators so that
// "12. mars 2024" survives as one string instead of three fragments.
//
// WHAT: BT/ET text objects, Tj/TJ/'/" show operators, Tf font selection,
// Td/TD/Tm/T* line movement, inline-image skipping (BI…ID…EI) and Form XObjects
// (Do), with inherited page resources. Output is one string per page.
import type { PdfDocument, PdfDict } from './pdf-document';
import { PDF_LIMITS } from './pdf-document';
import type { FontDecoder } from './pdf-encoding';
import { fontDecoder } from './pdf-encoding';
import { PdfLexer } from './pdf-objects';
import type { PdfValue } from './pdf-objects';

/** A TJ adjustment more negative than this (thousandths of text space) is a word gap. */
const WORD_GAP_THRESHOLD = -180;
/** Vertical movement larger than this (text-space units) starts a new line. */
const LINE_BREAK_THRESHOLD = 0.5;
/** Recursion bound for nested Form XObjects. */
const MAX_FORM_DEPTH = 8;
/** Bound on content bytes examined per page, so one hostile page cannot dominate. */
const MAX_CONTENT_BYTES = 32 * 1024 * 1024;

function isValueStart(byte: number): boolean {
  return (
    byte === 0x2f || byte === 0x28 || byte === 0x3c || byte === 0x5b ||
    byte === 0x2b || byte === 0x2d || byte === 0x2e || (byte >= 0x30 && byte <= 0x39)
  );
}

/** Walks /Parent links to find an inherited page attribute such as /Resources. */
function inherited(doc: PdfDocument, page: PdfDict, key: string): PdfValue | undefined {
  let node: PdfDict | null = page;
  let depth = 0;
  while (node !== null && depth < 64) {
    const value = node.get(key);
    if (value !== undefined) return value;
    node = doc.dictOf(node.get('Parent'));
    depth += 1;
  }
  return undefined;
}

function pageContent(doc: PdfDocument, page: PdfDict): Buffer {
  const contents = doc.resolve(page.get('Contents'));
  const parts: Buffer[] = [];
  let total = 0;
  const push = (value: PdfValue): void => {
    const body = doc.decoded(value);
    if (body === null) return;
    total += body.length;
    if (total > MAX_CONTENT_BYTES) return;
    parts.push(body, Buffer.from('\n'));
  };
  if (contents.type === 'array') {
    for (const item of contents.items) push(item);
  } else if (contents.type === 'stream') {
    push(contents);
  }
  return Buffer.concat(parts);
}

class TextAssembler {
  private lines: string[] = [];
  private current = '';
  private lastY: number | null = null;
  private lastX: number | null = null;
  private lastEndX: number | null = null;

  /** Registers a positioning change; a large vertical move begins a new line. */
  moveTo(x: number, y: number): void {
    if (this.lastY !== null && Math.abs(y - this.lastY) > LINE_BREAK_THRESHOLD) {
      this.newLine();
    } else if (this.lastEndX !== null && this.current.length > 0 && x - this.lastEndX > 1.5 && !this.current.endsWith(' ')) {
      // Same baseline, gap to the right: a tab stop or a column boundary.
      this.current += ' ';
    }
    this.lastX = x;
    this.lastY = y;
    this.lastEndX = null;
  }

  newLine(): void {
    if (this.current.trim().length > 0) this.lines.push(this.current.replace(/\s+$/g, ''));
    else if (this.current.length > 0 && this.lines.length > 0 && this.lines[this.lines.length - 1] !== '') this.lines.push('');
    this.current = '';
    this.lastEndX = null;
  }

  wordGap(): void {
    if (this.current.length > 0 && !this.current.endsWith(' ')) this.current += ' ';
  }

  append(text: string, advance: number): void {
    this.current += text;
    if (this.lastX !== null) {
      this.lastX += advance;
      this.lastEndX = this.lastX;
    }
  }

  finish(): string {
    this.newLine();
    return this.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
}

interface GraphicsState {
  readonly decoder: FontDecoder | null;
  readonly fontSize: number;
  readonly charSpacing: number;
  readonly wordSpacing: number;
  readonly horizontalScale: number;
}

/** Roughly how far a shown string advances the pen, in text-space units, without glyph widths. */
function approximateAdvance(text: string, state: GraphicsState): number {
  const perGlyph = 0.5 * state.fontSize;
  return (text.length * perGlyph + text.length * state.charSpacing) * (state.horizontalScale / 100);
}

function numberAt(operands: readonly PdfValue[], index: number): number {
  const value = operands[index];
  return value !== undefined && value.type === 'number' ? value.value : 0;
}

/** Skips an inline image: after `ID` the binary runs until a whitespace-delimited `EI`. */
function skipInlineImage(lexer: PdfLexer, bytes: Buffer): void {
  let token = lexer.readToken();
  let guard = 0;
  while (token !== null && token !== 'ID' && guard < 10_000) {
    token = lexer.readToken();
    guard += 1;
  }
  let cursor = lexer.offset + 1;
  while (cursor < bytes.length) {
    const found = bytes.indexOf('EI', cursor, 'latin1');
    if (found === -1) {
      lexer.offset = bytes.length;
      return;
    }
    const before = bytes[found - 1] ?? 0x20;
    const after = bytes[found + 2] ?? 0x20;
    const whitespace = (byte: number): boolean => byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x0c || byte === 0x00;
    if (whitespace(before) && whitespace(after)) {
      lexer.offset = found + 2;
      return;
    }
    cursor = found + 2;
  }
  lexer.offset = bytes.length;
}

function extractFromContent(
  doc: PdfDocument,
  content: Buffer,
  resources: PdfDict | null,
  assembler: TextAssembler,
  depth: number,
  fontCache: Map<PdfDict, FontDecoder>,
): void {
  const lexer = new PdfLexer(content);
  const operands: PdfValue[] = [];
  let state: GraphicsState = { decoder: null, fontSize: 1, charSpacing: 0, wordSpacing: 0, horizontalScale: 100 };
  const stack: GraphicsState[] = [];
  let leading = 0;
  let textY = 0;
  let textX = 0;
  let lineY = 0;
  let lineX = 0;
  const fonts = doc.dictOf(resources?.get('Font'));
  const xobjects = doc.dictOf(resources?.get('XObject'));

  const decoderFor = (name: string): FontDecoder | null => {
    if (fonts === null) return null;
    const font = doc.dictOf(fonts.get(name));
    if (font === null) return null;
    const cached = fontCache.get(font);
    if (cached !== undefined) return cached;
    const decoder = fontDecoder(doc, font);
    fontCache.set(font, decoder);
    return decoder;
  };

  const show = (value: PdfValue): void => {
    if (value.type !== 'string') return;
    const text = state.decoder === null ? value.bytes.toString('latin1') : state.decoder.decode(value.bytes);
    if (text.length === 0) return;
    assembler.append(text, approximateAdvance(text, state));
  };

  let guard = 0;
  while (!lexer.atEnd() && guard < 5_000_000) {
    guard += 1;
    lexer.skipTrivia();
    if (lexer.atEnd()) break;
    const byte = content[lexer.offset] as number;
    if (isValueStart(byte)) {
      const value = lexer.parseValue(false);
      if (value === null) {
        lexer.readToken();
        continue;
      }
      operands.push(value);
      if (operands.length > 64) operands.shift();
      continue;
    }
    const op = lexer.readToken();
    if (op === null) break;
    switch (op) {
      case 'BT':
        textX = 0;
        textY = 0;
        lineX = 0;
        lineY = 0;
        assembler.moveTo(0, 0);
        break;
      case 'ET':
        break;
      case 'Tf': {
        const fontName = operands[operands.length - 2];
        const size = numberAt(operands, operands.length - 1);
        state = { ...state, decoder: fontName !== undefined && fontName.type === 'name' ? decoderFor(fontName.name) : null, fontSize: size || 1 };
        break;
      }
      case 'Tc':
        state = { ...state, charSpacing: numberAt(operands, operands.length - 1) };
        break;
      case 'Tw':
        state = { ...state, wordSpacing: numberAt(operands, operands.length - 1) };
        break;
      case 'Tz':
        state = { ...state, horizontalScale: numberAt(operands, operands.length - 1) || 100 };
        break;
      case 'TL':
        leading = numberAt(operands, operands.length - 1);
        break;
      case 'Td':
      case 'TD': {
        const tx = numberAt(operands, operands.length - 2);
        const ty = numberAt(operands, operands.length - 1);
        if (op === 'TD') leading = -ty;
        lineX += tx;
        lineY += ty;
        textX = lineX;
        textY = lineY;
        assembler.moveTo(textX, textY);
        break;
      }
      case 'Tm': {
        // Only the translation part matters for line reconstruction; the scale
        // components would matter for glyph-accurate advances, which this
        // extractor deliberately approximates.
        const e = numberAt(operands, operands.length - 2);
        const f = numberAt(operands, operands.length - 1);
        lineX = e;
        lineY = f;
        textX = e;
        textY = f;
        assembler.moveTo(textX, textY);
        break;
      }
      case 'T*':
        lineY -= leading;
        textY = lineY;
        textX = lineX;
        assembler.newLine();
        assembler.moveTo(textX, textY);
        break;
      case 'Tj':
        show(operands[operands.length - 1] ?? { type: 'null' });
        break;
      case "'":
        lineY -= leading;
        textY = lineY;
        textX = lineX;
        assembler.newLine();
        assembler.moveTo(textX, textY);
        show(operands[operands.length - 1] ?? { type: 'null' });
        break;
      case '"':
        state = { ...state, wordSpacing: numberAt(operands, operands.length - 3), charSpacing: numberAt(operands, operands.length - 2) };
        lineY -= leading;
        textY = lineY;
        textX = lineX;
        assembler.newLine();
        assembler.moveTo(textX, textY);
        show(operands[operands.length - 1] ?? { type: 'null' });
        break;
      case 'TJ': {
        const array = operands[operands.length - 1];
        if (array !== undefined && array.type === 'array') {
          for (const item of array.items) {
            if (item.type === 'string') show(item);
            else if (item.type === 'number' && item.value < WORD_GAP_THRESHOLD) assembler.wordGap();
          }
        }
        break;
      }
      case 'q':
        stack.push(state);
        if (stack.length > 256) stack.shift();
        break;
      case 'Q':
        state = stack.pop() ?? state;
        break;
      case 'BI':
        skipInlineImage(lexer, content);
        break;
      case 'Do': {
        const name = operands[operands.length - 1];
        if (name !== undefined && name.type === 'name' && xobjects !== null && depth < MAX_FORM_DEPTH) {
          const xobject = doc.streamOf(xobjects.get(name.name));
          if (xobject !== null) {
            const subtype = doc.resolve(xobject.dict.get('Subtype'));
            if (subtype.type === 'name' && subtype.name === 'Form') {
              const body = doc.decoded(xobject);
              if (body !== null) {
                const formResources = doc.dictOf(xobject.dict.get('Resources')) ?? resources;
                assembler.newLine();
                extractFromContent(doc, body, formResources, assembler, depth + 1, fontCache);
              }
            }
          }
        }
        break;
      }
      default:
        break;
    }
    operands.length = 0;
  }
}

/** Extracts the text of every page, in page-tree order. Pages without text yield ''. */
export function extractPageTexts(doc: PdfDocument): string[] {
  const fontCache = new Map<PdfDict, FontDecoder>();
  const texts: string[] = [];
  for (const page of doc.pages.slice(0, PDF_LIMITS.maxPages)) {
    const assembler = new TextAssembler();
    const resources = doc.dictOf(inherited(doc, page, 'Resources'));
    const content = pageContent(doc, page);
    extractFromContent(doc, content, resources, assembler, 0, fontCache);
    texts.push(assembler.finish());
  }
  return texts;
}
