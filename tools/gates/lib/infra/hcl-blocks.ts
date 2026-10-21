/**
 * HCL block reader for Terraform files (ARIA-HIGH-012).
 *
 * WHY a lexer and not a regex: a `version =` inside a heredoc, a `}` inside a comment or a
 * template string, and nested blocks all defeat line matching. This reader tokenises strings
 * (with `${}`/`%{}` templates), heredocs (`<<EOT`, `<<-EOT`) and all three comment forms,
 * then builds a tree of blocks and attributes. It never evaluates an expression: attributes
 * keep their raw text, plus the literal when the value is a single string and the entries
 * when it is an object, which is all the pin rules need.
 */
import type { ReadError } from './read-error';

export interface HclAttribute {
  readonly name: string;
  readonly line: number;
  /** Source text of the value expression. */
  readonly raw: string;
  /** The value when it is exactly one string literal (template text kept verbatim). */
  readonly string: string | null;
  /** The entries when the value is an object constructor `{ k = v, ... }`. */
  readonly object: Readonly<Record<string, HclAttribute>> | null;
}

export interface HclBlock {
  readonly type: string;
  readonly labels: readonly string[];
  readonly line: number;
  readonly attributes: Readonly<Record<string, HclAttribute>>;
  readonly blocks: readonly HclBlock[];
}

export interface HclRead {
  readonly attributes: Readonly<Record<string, HclAttribute>>;
  readonly blocks: readonly HclBlock[];
  readonly errors: readonly ReadError[];
}

type TokenKind = 'ident' | 'string' | 'heredoc' | 'number' | 'punct' | 'newline';

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_-]/;
const TWO_CHAR_OPS: ReadonlySet<string> = new Set(['==', '!=', '<=', '>=', '&&', '||', '=>']);

class Lexer {
  readonly tokens: Token[] = [];
  readonly errors: ReadError[] = [];
  private pos = 0;
  private line = 1;

  constructor(private readonly src: string) {
    this.run();
  }

  private push(kind: TokenKind, start: number, line: number): void {
    this.tokens.push({ kind, text: this.src.slice(start, this.pos), line, start, end: this.pos });
  }

  private run(): void {
    const s = this.src;
    while (this.pos < s.length) {
      const c = s.charAt(this.pos);
      const start = this.pos;
      const line = this.line;
      if (c === '\n') {
        this.pos += 1;
        this.push('newline', start, line);
        this.line += 1;
      } else if (c === ' ' || c === '\t' || c === '\r') {
        this.pos += 1;
      } else if (c === '#' || (c === '/' && s[this.pos + 1] === '/')) {
        while (this.pos < s.length && s[this.pos] !== '\n') this.pos += 1;
      } else if (c === '/' && s[this.pos + 1] === '*') {
        const close = s.indexOf('*/', this.pos + 2);
        const end = close < 0 ? s.length : close + 2;
        if (close < 0) this.errors.push({ line, message: 'unterminated /* comment' });
        this.countLines(this.pos, end);
        this.pos = end;
      } else if (c === '"') {
        this.readString();
        this.push('string', start, line);
      } else if (
        c === '<' &&
        s[this.pos + 1] === '<' &&
        /^<<-?[A-Za-z_]/.test(s.slice(this.pos, this.pos + 4))
      ) {
        this.readHeredoc();
        this.push('heredoc', start, line);
      } else if (IDENT_START.test(c)) {
        while (this.pos < s.length && IDENT_PART.test(s.charAt(this.pos))) this.pos += 1;
        this.push('ident', start, line);
      } else if (/[0-9]/.test(c)) {
        while (this.pos < s.length && /[0-9.eE]/.test(s.charAt(this.pos))) this.pos += 1;
        this.push('number', start, line);
      } else {
        const two = s.slice(this.pos, this.pos + 2);
        this.pos += s.slice(this.pos, this.pos + 3) === '...' ? 3 : TWO_CHAR_OPS.has(two) ? 2 : 1;
        this.push('punct', start, line);
      }
    }
  }

  private countLines(from: number, to: number): void {
    for (let i = from; i < to; i += 1) if (this.src[i] === '\n') this.line += 1;
  }

  /** A quoted template: escapes, and `${ }` / `%{ }` sequences that may nest strings. */
  private readString(): void {
    const s = this.src;
    const line = this.line;
    this.pos += 1;
    while (this.pos < s.length) {
      const c = s.charAt(this.pos);
      if (c === '\\') {
        this.pos += 2;
      } else if (c === '"') {
        this.pos += 1;
        return;
      } else if (c === '\n') {
        this.errors.push({ line, message: 'newline in a quoted string' });
        return;
      } else if ((c === '$' || c === '%') && s[this.pos + 1] === '{') {
        if (s[this.pos - 1] === c) {
          this.pos += 2; // `$${` / `%%{` is a literal escape
        } else {
          this.pos += 2;
          this.readTemplateSequence(line);
        }
      } else {
        this.pos += 1;
      }
    }
    this.errors.push({ line, message: 'unterminated string' });
  }

  private readTemplateSequence(line: number): void {
    const s = this.src;
    let depth = 1;
    while (this.pos < s.length && depth > 0) {
      const c = s.charAt(this.pos);
      if (c === '"') {
        this.readString();
        continue;
      }
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '\n') this.line += 1;
      this.pos += 1;
    }
    if (depth > 0) this.errors.push({ line, message: 'unterminated template sequence' });
  }

  private readHeredoc(): void {
    const s = this.src;
    const line = this.line;
    const match = /^<<(-?)([A-Za-z_][A-Za-z0-9_-]*)[ \t]*\r?\n/.exec(s.slice(this.pos));
    if (match === null) {
      this.errors.push({ line, message: 'malformed heredoc introducer' });
      this.pos += 2;
      return;
    }
    const delimiter = String(match[2]);
    this.pos += match[0].length;
    this.line += 1;
    while (this.pos < s.length) {
      const eol = s.indexOf('\n', this.pos);
      const end = eol < 0 ? s.length : eol;
      const content = s.slice(this.pos, end).replace(/\r$/, '');
      if (content.trim() === delimiter) {
        this.pos = end; // the newline after the delimiter stays a token
        return;
      }
      this.pos = eol < 0 ? s.length : eol + 1;
      if (eol >= 0) this.line += 1;
    }
    this.errors.push({ line, message: `unterminated heredoc <<${delimiter}` });
  }
}

const OPEN = new Set(['{', '[', '(']);
const CLOSE = new Set(['}', ']', ')']);

class Parser {
  private i = 0;

  constructor(
    private readonly src: string,
    private readonly tokens: readonly Token[],
    readonly errors: ReadError[],
  ) {}

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.i + offset];
  }

  private skipNewlines(): void {
    for (let t = this.peek(); t !== undefined && t.kind === 'newline'; t = this.peek()) this.i += 1;
  }

  /** body := (attribute | block | newline)* until `}` (closed) or EOF (top level). */
  parseBody(closer: '}' | null): { attributes: Record<string, HclAttribute>; blocks: HclBlock[] } {
    const attributes: Record<string, HclAttribute> = {};
    const blocks: HclBlock[] = [];
    for (;;) {
      this.skipNewlines();
      const token = this.peek();
      if (token === undefined) {
        if (closer !== null) this.errors.push({ line: this.lastLine(), message: 'unclosed block' });
        return { attributes, blocks };
      }
      if (token.kind === 'punct' && token.text === '}') {
        if (closer === null) this.errors.push({ line: token.line, message: 'unexpected }' });
        this.i += 1;
        if (closer !== null) return { attributes, blocks };
        continue;
      }
      if (token.kind !== 'ident') {
        this.errors.push({ line: token.line, message: `unexpected ${token.text}` });
        this.skipLine();
        continue;
      }
      const next = this.peek(1);
      if (next !== undefined && next.kind === 'punct' && next.text === '=') {
        this.i += 2;
        attributes[token.text] = this.parseAttributeValue(token, false);
        continue;
      }
      blocks.push(this.parseBlock(token));
    }
  }

  private parseBlock(typeToken: Token): HclBlock {
    this.i += 1;
    const labels: string[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined || token.kind === 'newline') {
        this.errors.push({ line: typeToken.line, message: `block ${typeToken.text} has no body` });
        return { type: typeToken.text, labels, line: typeToken.line, attributes: {}, blocks: [] };
      }
      if (token.kind === 'punct' && token.text === '{') break;
      if (token.kind === 'string') labels.push(unquote(token.text));
      else if (token.kind === 'ident') labels.push(token.text);
      else
        this.errors.push({ line: token.line, message: `unexpected ${token.text} in block header` });
      this.i += 1;
    }
    this.i += 1;
    const body = this.parseBody('}');
    return { type: typeToken.text, labels, line: typeToken.line, ...body };
  }

  /** Value tokens up to a newline (or `,` / `}` inside an object) at bracket depth 0. */
  private parseAttributeValue(nameToken: Token, inObject: boolean): HclAttribute {
    const first = this.peek();
    const startIndex = this.i;
    let depth = 0;
    for (;;) {
      const token = this.peek();
      if (token === undefined) break;
      if (depth === 0 && token.kind === 'newline') break;
      if (
        depth === 0 &&
        token.kind === 'punct' &&
        (token.text === '}' || (inObject && token.text === ','))
      )
        break;
      if (token.kind === 'punct' && OPEN.has(token.text)) depth += 1;
      if (token.kind === 'punct' && CLOSE.has(token.text)) depth -= 1;
      this.i += 1;
    }
    const valueTokens = this.tokens.slice(startIndex, this.i).filter((t) => t.kind !== 'newline');
    const last = valueTokens[valueTokens.length - 1];
    const raw =
      first === undefined || last === undefined ? '' : this.src.slice(first.start, last.end).trim();
    if (valueTokens.length === 0)
      this.errors.push({ line: nameToken.line, message: `${nameToken.text} has no value` });
    const only = valueTokens.length === 1 ? valueTokens[0] : undefined;
    return {
      name: nameToken.text,
      line: nameToken.line,
      raw,
      string: only !== undefined && only.kind === 'string' ? unquote(only.text) : null,
      object: this.parseObject(valueTokens),
    };
  }

  /** Parse `{ k = v, k2: v2 }` value tokens into entries; null for anything else. */
  private parseObject(valueTokens: readonly Token[]): Record<string, HclAttribute> | null {
    const open = valueTokens[0];
    const close = valueTokens[valueTokens.length - 1];
    if (open === undefined || close === undefined || open.text !== '{' || close.text !== '}')
      return null;
    const firstInner = valueTokens[1];
    if (firstInner !== undefined && firstInner.kind === 'ident' && firstInner.text === 'for')
      return null;
    const inner = this.tokens.slice(this.tokens.indexOf(open) + 1, this.tokens.indexOf(close));
    const sub = new Parser(this.src, inner, []);
    return sub.parseObjectEntries();
  }

  private parseObjectEntries(): Record<string, HclAttribute> | null {
    const entries: Record<string, HclAttribute> = {};
    for (;;) {
      for (
        let t = this.peek();
        t !== undefined && (t.kind === 'newline' || t.text === ',');
        t = this.peek()
      )
        this.i += 1;
      const key = this.peek();
      if (key === undefined) return entries;
      const sep = this.peek(1);
      if (
        (key.kind !== 'ident' && key.kind !== 'string') ||
        sep === undefined ||
        (sep.text !== '=' && sep.text !== ':')
      ) {
        return null;
      }
      this.i += 2;
      const name = key.kind === 'string' ? unquote(key.text) : key.text;
      entries[name] = { ...this.parseAttributeValue(key, true), name };
    }
  }

  private skipLine(): void {
    for (let t = this.peek(); t !== undefined && t.kind !== 'newline'; t = this.peek()) this.i += 1;
  }

  private lastLine(): number {
    const last = this.tokens[this.tokens.length - 1];
    return last === undefined ? 1 : last.line;
  }
}

function unquote(text: string): string {
  return text.startsWith('"') && text.endsWith('"') && text.length >= 2 ? text.slice(1, -1) : text;
}

export function readHclBlocks(text: string): HclRead {
  const lexer = new Lexer(text);
  const errors = [...lexer.errors];
  const parser = new Parser(text, lexer.tokens, errors);
  const body = parser.parseBody(null);
  return { attributes: body.attributes, blocks: body.blocks, errors };
}
