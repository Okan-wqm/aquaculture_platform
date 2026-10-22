/**
 * NATS server configuration reader (ARIA-HIGH-012).
 *
 * WHY a reader: the NATS config format is HOCON-like — `k: v`, `k = v` and `k v` all assign,
 * a map may follow its key with no separator, arrays and maps nest, `include <file>` pulls a
 * file in, and both `#` and `//` start comments. A text search for `password:` fires on a
 * commented-out line and misses `password = x`. Rules about NATS identity read this tree.
 *
 * Values keep their raw text and whether they were quoted: an unquoted `$NAME` is a variable
 * reference the server substitutes, a quoted "$NAME" is a literal string.
 */
import { MAX_NESTING_DEPTH, nestingError, type ReadError } from './read-error';

export type NatsValue =
  | {
      readonly kind: 'scalar';
      readonly raw: string;
      readonly quoted: boolean;
      readonly line: number;
    }
  | { readonly kind: 'map'; readonly entries: readonly NatsEntry[]; readonly line: number }
  | { readonly kind: 'array'; readonly items: readonly NatsValue[]; readonly line: number };

export interface NatsEntry {
  readonly key: string;
  readonly value: NatsValue;
  readonly line: number;
}

export interface NatsRead {
  readonly tree: readonly NatsEntry[];
  readonly errors: readonly ReadError[];
}

class NatsParser {
  readonly errors: ReadError[] = [];
  private pos = 0;
  private line = 1;
  /** Set once a nesting past MAX_NESTING_DEPTH stopped the read: the unread rest is not "unclosed". */
  private abandoned = false;

  constructor(private readonly src: string) {}

  /** Stop reading: record the nesting error once and move to the end of the input. */
  private abandon(line: number): void {
    this.errors.push(nestingError(line));
    this.abandoned = true;
    this.pos = this.src.length;
  }

  private get ch(): string | undefined {
    return this.src[this.pos];
  }

  private advance(n = 1): void {
    for (let k = 0; k < n && this.pos < this.src.length; k += 1) {
      if (this.src[this.pos] === '\n') this.line += 1;
      this.pos += 1;
    }
  }

  private atComment(): boolean {
    return this.ch === '#' || (this.ch === '/' && this.src[this.pos + 1] === '/');
  }

  private skipComment(): void {
    while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1;
  }

  /** Skip whitespace, comments and (optionally) newlines / item separators. */
  private skip(newlines: boolean): void {
    for (;;) {
      const c = this.ch;
      if (c === undefined) return;
      if (c === ' ' || c === '\t' || c === '\r') this.advance();
      else if (newlines && (c === '\n' || c === ',' || c === ';')) this.advance();
      else if (this.atComment()) this.skipComment();
      else return;
    }
  }

  /** `depth` counts the maps and arrays around these entries (0 at the top level). */
  parseEntries(closer: '}' | null, openLine: number, depth: number): NatsEntry[] {
    const entries: NatsEntry[] = [];
    for (;;) {
      this.skip(true);
      const c = this.ch;
      if (c === undefined) {
        if (closer !== null && !this.abandoned)
          this.errors.push({ line: openLine, message: 'map is not closed' });
        return entries;
      }
      if (c === '}') {
        this.advance();
        if (closer !== null) return entries;
        this.errors.push({ line: this.line, message: 'unexpected }' });
        continue;
      }
      const line = this.line;
      const key = this.readKey();
      if (key.length === 0) {
        this.errors.push({ line, message: 'entry without a key' });
        this.skipComment();
        continue;
      }
      this.skip(false);
      if (this.ch === ':' || this.ch === '=') {
        this.advance();
        this.skip(false);
      }
      entries.push({ key, value: this.readValue(line, depth), line });
    }
  }

  private readKey(): string {
    if (this.ch === '"' || this.ch === "'") return this.readQuoted();
    const start = this.pos;
    while (this.ch !== undefined && !/[\s:={}[\],;#]/.test(this.ch)) this.advance();
    return this.src.slice(start, this.pos);
  }

  private readQuoted(): string {
    const quote = this.src.charAt(this.pos);
    const line = this.line;
    this.advance();
    let value = '';
    while (this.ch !== undefined && this.ch !== quote) {
      if (this.ch === '\\' && this.src[this.pos + 1] !== undefined) {
        value += this.src[this.pos + 1];
        this.advance(2);
        continue;
      }
      if (this.ch === '\n') {
        this.errors.push({ line, message: 'newline in a quoted string' });
        return value;
      }
      value += this.ch;
      this.advance();
    }
    if (this.ch === undefined) this.errors.push({ line, message: 'unterminated quoted string' });
    else this.advance();
    return value;
  }

  private readValue(line: number, depth: number): NatsValue {
    const c = this.ch;
    if ((c === '{' || c === '[') && depth >= MAX_NESTING_DEPTH) {
      this.abandon(line);
      return c === '{' ? { kind: 'map', entries: [], line } : { kind: 'array', items: [], line };
    }
    if (c === '{') {
      this.advance();
      return { kind: 'map', entries: this.parseEntries('}', line, depth + 1), line };
    }
    if (c === '[') {
      this.advance();
      return { kind: 'array', items: this.readArray(line, depth + 1), line };
    }
    if (c === '"' || c === "'")
      return { kind: 'scalar', raw: this.readQuoted(), quoted: true, line };
    const start = this.pos;
    while (this.ch !== undefined && !/[\n,;}\]]/.test(this.ch)) {
      // A comment starts at `#` or `//` preceded by whitespace (a URL keeps its `//`).
      if (
        (this.ch === '#' || this.ch === '/') &&
        /\s/.test(this.src[this.pos - 1] ?? ' ') &&
        this.atComment()
      )
        break;
      this.advance();
    }
    const raw = this.src.slice(start, this.pos).trim();
    if (raw.length === 0) this.errors.push({ line, message: 'missing value' });
    return { kind: 'scalar', raw, quoted: false, line };
  }

  private readArray(openLine: number, depth: number): NatsValue[] {
    const items: NatsValue[] = [];
    for (;;) {
      this.skip(true);
      const c = this.ch;
      if (c === undefined) {
        if (!this.abandoned) this.errors.push({ line: openLine, message: 'array is not closed' });
        return items;
      }
      if (c === ']') {
        this.advance();
        return items;
      }
      // readValue stops on `}` without consuming it (it ends a value inside a map), so inside
      // an array a stray `}` must be consumed here or this loop never advances.
      if (c === '}') {
        this.errors.push({ line: this.line, message: 'unexpected } in array' });
        this.advance();
        continue;
      }
      items.push(this.readValue(this.line, depth));
    }
  }
}

export function readNatsConf(text: string): NatsRead {
  const parser = new NatsParser(text);
  const tree = parser.parseEntries(null, 1, 0);
  return { tree, errors: parser.errors };
}
