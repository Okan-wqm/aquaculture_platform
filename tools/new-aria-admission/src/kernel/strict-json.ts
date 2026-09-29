export type JsonScalar = null | boolean | number | string;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

const maximumDocumentBytes = 4 * 1024 * 1024;
const maximumNestingDepth = 64;
const maximumValueCount = 100_000;

export class StrictJsonError extends Error {
  constructor(message: string, offset?: number) {
    super(offset === undefined ? message : `${message} at offset ${offset}`);
    this.name = 'StrictJsonError';
  }
}

class Parser {
  private offset = 0;
  private valueCount = 0;

  constructor(private readonly source: string) {}

  parse(): JsonValue {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.offset !== this.source.length) {
      throw new StrictJsonError('trailing content', this.offset);
    }
    return value;
  }

  private parseValue(depth = 0): JsonValue {
    this.valueCount += 1;
    if (this.valueCount > maximumValueCount) {
      throw new StrictJsonError('JSON value limit exceeded', this.offset);
    }
    const token = this.source[this.offset];
    if (token === '{' || token === '[') {
      if (depth >= maximumNestingDepth) {
        throw new StrictJsonError('JSON nesting limit exceeded', this.offset);
      }
      return token === '{' ? this.parseObject(depth + 1) : this.parseArray(depth + 1);
    }
    if (token === '"') return this.parseString();
    if (token === '-' || this.isDigit(token)) return this.parseInteger();
    if (this.consumeKeyword('true')) return true;
    if (this.consumeKeyword('false')) return false;
    if (this.consumeKeyword('null')) return null;
    throw new StrictJsonError('unexpected token', this.offset);
  }

  private parseObject(depth: number): { [key: string]: JsonValue } {
    this.offset += 1;
    const result: { [key: string]: JsonValue } = Object.create(null) as {
      [key: string]: JsonValue;
    };
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.consume('}')) return result;
    while (true) {
      if (this.source[this.offset] !== '"') {
        throw new StrictJsonError('object key must be a string', this.offset);
      }
      const key = this.parseString();
      if (keys.has(key)) throw new StrictJsonError(`duplicate key ${key}`, this.offset);
      keys.add(key);
      this.skipWhitespace();
      this.expect(':');
      this.skipWhitespace();
      result[key] = this.parseValue(depth);
      this.skipWhitespace();
      if (this.consume('}')) return result;
      this.expect(',');
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): JsonValue[] {
    this.offset += 1;
    const result: JsonValue[] = [];
    this.skipWhitespace();
    if (this.consume(']')) return result;
    while (true) {
      result.push(this.parseValue(depth));
      this.skipWhitespace();
      if (this.consume(']')) return result;
      this.expect(',');
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    this.expect('"');
    let result = '';
    while (this.offset < this.source.length) {
      const char = this.source[this.offset];
      this.offset += 1;
      if (char === '"') return result;
      if (char === '\\') {
        result += this.parseEscape();
        continue;
      }
      if (char === undefined || char.charCodeAt(0) < 0x20) {
        throw new StrictJsonError('invalid string character', this.offset - 1);
      }
      const point = this.source.codePointAt(this.offset - 1);
      if (point === undefined || (point >= 0xd800 && point <= 0xdfff)) {
        throw new StrictJsonError('invalid Unicode scalar', this.offset - 1);
      }
      result += String.fromCodePoint(point);
      if (point > 0xffff) this.offset += 1;
    }
    throw new StrictJsonError('unterminated string', this.offset);
  }

  private parseEscape(): string {
    const escape = this.source[this.offset];
    this.offset += 1;
    const simple: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    if (escape !== undefined && Object.prototype.hasOwnProperty.call(simple, escape)) {
      return simple[escape] ?? '';
    }
    if (escape !== 'u') throw new StrictJsonError('invalid string escape', this.offset - 1);
    const first = this.readHexCodeUnit();
    if (first >= 0xdc00 && first <= 0xdfff) {
      throw new StrictJsonError('unpaired low surrogate', this.offset - 4);
    }
    if (first < 0xd800 || first > 0xdbff) return String.fromCharCode(first);
    if (this.source.slice(this.offset, this.offset + 2) !== '\\u') {
      throw new StrictJsonError('unpaired high surrogate', this.offset - 4);
    }
    this.offset += 2;
    const second = this.readHexCodeUnit();
    if (second < 0xdc00 || second > 0xdfff) {
      throw new StrictJsonError('invalid surrogate pair', this.offset - 4);
    }
    return String.fromCodePoint(0x10000 + ((first - 0xd800) << 10) + second - 0xdc00);
  }

  private readHexCodeUnit(): number {
    const digits = this.source.slice(this.offset, this.offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
      throw new StrictJsonError('invalid Unicode escape', this.offset);
    }
    this.offset += 4;
    return Number.parseInt(digits, 16);
  }

  private parseInteger(): number {
    const start = this.offset;
    if (this.consume('-') && this.source[this.offset] === '0') {
      throw new StrictJsonError('integer cannot be negative zero', start);
    }
    if (this.consume('0')) {
      if (this.isDigit(this.source[this.offset])) {
        throw new StrictJsonError('integer cannot have a leading zero', start);
      }
    } else {
      const first = this.source[this.offset];
      if (first === undefined || first < '1' || first > '9') {
        throw new StrictJsonError('invalid integer', start);
      }
      this.offset += 1;
      while (this.isDigit(this.source[this.offset])) this.offset += 1;
    }
    const terminator = this.source[this.offset];
    if (terminator === '.' || terminator === 'e' || terminator === 'E') {
      throw new StrictJsonError('integer-only JSON required', start);
    }
    const value = Number(this.source.slice(start, this.offset));
    if (!Number.isSafeInteger(value)) throw new StrictJsonError('unsafe integer', start);
    return value;
  }

  private skipWhitespace(): void {
    while (' \t\n\r'.includes(this.source[this.offset] ?? '\u0000')) this.offset += 1;
  }

  private consume(expected: string): boolean {
    if (this.source[this.offset] !== expected) return false;
    this.offset += expected.length;
    return true;
  }

  private consumeKeyword(expected: string): boolean {
    if (!this.source.startsWith(expected, this.offset)) return false;
    this.offset += expected.length;
    return true;
  }

  private expect(expected: string): void {
    if (!this.consume(expected)) throw new StrictJsonError(`expected ${expected}`, this.offset);
  }

  private isDigit(value: string | undefined): boolean {
    return value !== undefined && value >= '0' && value <= '9';
  }
}

export function parseStrictJson(bytes: Uint8Array): JsonValue {
  if (bytes.byteLength > maximumDocumentBytes) {
    throw new StrictJsonError('JSON byte limit exceeded');
  }
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new StrictJsonError('invalid UTF-8');
  }
  return new Parser(source).parse();
}
