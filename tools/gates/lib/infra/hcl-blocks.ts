/**
 * HCL block reader for Terraform files (ARIA-HIGH-012).
 *
 * WHY a lexer and not a regex: a `version =` inside a heredoc, a `}` inside a comment or a
 * template string, and nested blocks all defeat line matching. This reader tokenises strings
 * (with `${}`/`%{}` templates), heredocs (`<<EOT`, `<<-EOT`) and all three comment forms,
 * then builds a tree of blocks and attributes. It never evaluates an expression: attributes
 * keep their raw text, plus the literal when the value is a single string and the entries
 * when it is an object, which is all the pin rules need.
 *
 * A quoted string literal is read as its value, the string Terraform evaluates, not its token
 * text: the escapes of HCL's native syntax (`\n`, `\r`, `\t`, `\"`, `\\`, `\uNNNN`,
 * `\UNNNNNNNN`) are decoded and `$${` / `%%{` are a literal `${` / `%{`. A quoted string that
 * holds a `${...}` interpolation or a `%{...}` directive is a template, which this reader does
 * not evaluate, so it has no literal value. WHY the value: terraform-pins.ts judged and reported
 * the token text, so an `@` written `\u0040` was no `@` to it while Terraform handed go-getter
 * a userinfo, and the user was reported as a host (ARIA-HIGH-012 round-5 review R1 residual-2).
 * Decoding here, in the one HCL reader, makes every consumer see what Terraform sees.
 */
import {
  MAX_NESTING_DEPTH,
  nestingError,
  type ReadError,
  type ReadErrorTokenKind,
} from './read-error';

export interface HclAttribute {
  readonly name: string;
  readonly line: number;
  /** Source text of the value expression. */
  readonly raw: string;
  /**
   * The evaluated value when the value is exactly one quoted string literal (escapes decoded);
   * null for any other expression, a template with a `${...}` or `%{...}` sequence included.
   */
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

/**
 * How an error names a token: by its kind, never its text. A heredoc token's text is its whole
 * body and a number may be an all-digit credential (read-error.ts, ARIA-HIGH-012 round-3 R2).
 */
const TOKEN_KIND_NAME: Readonly<Record<TokenKind, ReadErrorTokenKind>> = {
  ident: 'identifier',
  string: 'string',
  heredoc: 'heredoc',
  number: 'number',
  punct: 'punctuation',
  newline: 'newline',
};

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly line: number;
  readonly start: number;
  readonly end: number;
  /**
   * A `string` token's evaluated value when it is a literal; null for a template, a string with
   * an invalid escape or an unterminated one, and for every other kind of token.
   */
  readonly literal: string | null;
}

/** The single-character escapes of a quoted HCL string and the character each one stands for. */
const SIMPLE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['"', '"'],
  ['\\', '\\'],
]);
/** `\u` takes exactly four hex digits, `\U` exactly eight. */
const UNICODE_ESCAPE_DIGITS: ReadonlyMap<string, number> = new Map([
  ['u', 4],
  ['U', 8],
]);
const HEX_DIGITS = /^[0-9A-Fa-f]+$/;

/**
 * The character an escape at `at` (the backslash) stands for and its length, or null when it is
 * not one HCL decodes: an unknown selector, too few hex digits, or a code point UTF-8 cannot
 * encode (a surrogate or one past U+10FFFF), each of which Terraform rejects.
 */
function readEscape(
  s: string,
  at: number,
): { readonly value: string; readonly length: number } | null {
  const selector = s.charAt(at + 1);
  const simple = SIMPLE_ESCAPES.get(selector);
  if (simple !== undefined) return { value: simple, length: 2 };
  const digits = UNICODE_ESCAPE_DIGITS.get(selector);
  if (digits === undefined) return null;
  const hex = s.slice(at + 2, at + 2 + digits);
  if (hex.length !== digits || !HEX_DIGITS.test(hex)) return null;
  const codePoint = Number.parseInt(hex, 16);
  if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return null;
  return { value: String.fromCodePoint(codePoint), length: 2 + digits };
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_-]/;
const TWO_CHAR_OPS: ReadonlySet<string> = new Set(['==', '!=', '<=', '>=', '&&', '||', '=>']);

class Lexer {
  readonly tokens: Token[] = [];
  readonly errors: ReadError[] = [];
  private pos = 0;
  private line = 1;
  /** Set once a template nesting past MAX_NESTING_DEPTH stopped the lexer at the end of input. */
  private abandoned = false;

  constructor(private readonly src: string) {
    this.run();
  }

  private push(kind: TokenKind, start: number, line: number, literal: string | null = null): void {
    this.tokens.push({
      kind,
      text: this.src.slice(start, this.pos),
      line,
      start,
      end: this.pos,
      literal,
    });
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
        const literal = this.readString(0);
        this.push('string', start, line, literal);
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

  /**
   * A quoted template: escapes, and `${ }` / `%{ }` sequences that may nest strings. `depth` counts
   * the template sequences around this string; past MAX_NESTING_DEPTH the lexer stops. Returns the
   * string's evaluated value when it is a literal (see the file comment), else null.
   */
  private readString(depth: number): string | null {
    const s = this.src;
    const line = this.line;
    if (depth > MAX_NESTING_DEPTH) {
      this.errors.push(nestingError(line));
      this.abandoned = true;
      this.pos = s.length;
      return null;
    }
    this.pos += 1;
    let value: string | null = '';
    while (this.pos < s.length) {
      const c = s.charAt(this.pos);
      if (c === '\\') {
        const escape = readEscape(s, this.pos);
        if (escape === null) {
          // Terraform rejects the file; past the backslash, the rest is read as text.
          this.errors.push({ line, message: 'invalid escape sequence in a quoted string' });
          value = null;
          this.pos += 1;
        } else {
          if (value !== null) value += escape.value;
          this.pos += escape.length;
        }
      } else if (c === '"') {
        this.pos += 1;
        return value;
      } else if (c === '\n') {
        this.errors.push({ line, message: 'newline in a quoted string' });
        return null;
      } else if ((c === '$' || c === '%') && s[this.pos + 1] === c && s[this.pos + 2] === '{') {
        // `$${` / `%%{` is a literal `${` / `%{`
        if (value !== null) value += `${c}{`;
        this.pos += 3;
      } else if ((c === '$' || c === '%') && s[this.pos + 1] === '{') {
        // an interpolation or directive: a template, which has no literal value
        value = null;
        this.pos += 2;
        this.readTemplateSequence(line, depth + 1);
      } else {
        if (value !== null) value += c;
        this.pos += 1;
      }
    }
    if (!this.abandoned) this.errors.push({ line, message: 'unterminated string' });
    return null;
  }

  private readTemplateSequence(line: number, depth: number): void {
    const s = this.src;
    let braces = 1;
    while (this.pos < s.length && braces > 0) {
      const c = s.charAt(this.pos);
      if (c === '"') {
        this.readString(depth);
        continue;
      }
      if (c === '{') braces += 1;
      else if (c === '}') braces -= 1;
      else if (c === '\n') this.line += 1;
      this.pos += 1;
    }
    if (braces > 0 && !this.abandoned)
      this.errors.push({ line, message: 'unterminated template sequence' });
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
    this.errors.push({ line, message: 'unterminated heredoc' });
  }
}

const OPEN = new Set(['{', '[', '(']);
const CLOSE = new Set(['}', ']', ')']);

/**
 * Nesting state shared by a parser and the sub-parsers it builds for object values: the depth
 * error goes to the file's errors (a sub-parser's own errors are discarded) and is reported once.
 */
interface Nesting {
  readonly errors: ReadError[];
  /** Set once a block past MAX_NESTING_DEPTH stopped the read: the unread rest is not "unclosed". */
  abandoned: boolean;
  reported: boolean;
}

function refuseNesting(nesting: Nesting, line: number): void {
  if (!nesting.reported) nesting.errors.push(nestingError(line));
  nesting.reported = true;
}

class Parser {
  private i = 0;

  constructor(
    private readonly src: string,
    private readonly tokens: readonly Token[],
    readonly errors: ReadError[],
    private readonly nesting: Nesting,
  ) {}

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.i + offset];
  }

  private skipNewlines(): void {
    for (let t = this.peek(); t !== undefined && t.kind === 'newline'; t = this.peek()) this.i += 1;
  }

  /**
   * body := (attribute | block | newline)* until `}` (closed) or EOF (top level). `depth` counts
   * the blocks and objects around this body (0 at the top level).
   */
  parseBody(
    closer: '}' | null,
    depth: number,
  ): { attributes: Record<string, HclAttribute>; blocks: HclBlock[] } {
    const attributes: Record<string, HclAttribute> = {};
    const blocks: HclBlock[] = [];
    for (;;) {
      this.skipNewlines();
      const token = this.peek();
      if (token === undefined) {
        if (closer !== null && !this.nesting.abandoned)
          this.errors.push({ line: this.lastLine(), message: 'unclosed block' });
        return { attributes, blocks };
      }
      if (token.kind === 'punct' && token.text === '}') {
        if (closer === null) this.errors.push({ line: token.line, message: 'unexpected }' });
        this.i += 1;
        if (closer !== null) return { attributes, blocks };
        continue;
      }
      if (token.kind !== 'ident') {
        this.errors.push({
          line: token.line,
          message: `unexpected ${TOKEN_KIND_NAME[token.kind]}` as const,
        });
        this.skipLine();
        continue;
      }
      const next = this.peek(1);
      if (next !== undefined && next.kind === 'punct' && next.text === '=') {
        this.i += 2;
        attributes[token.text] = this.parseAttributeValue(token, false, depth);
        continue;
      }
      blocks.push(this.parseBlock(token, depth));
    }
  }

  private parseBlock(typeToken: Token, depth: number): HclBlock {
    this.i += 1;
    const labels: string[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined || token.kind === 'newline') {
        this.errors.push({ line: typeToken.line, message: 'block has no body' });
        return { type: typeToken.text, labels, line: typeToken.line, attributes: {}, blocks: [] };
      }
      if (token.kind === 'punct' && token.text === '{') break;
      if (token.kind === 'string') {
        // A label is a literal in HCL; a template there is an error Terraform reports too.
        if (token.literal === null)
          this.errors.push({ line: token.line, message: 'block label is not a string literal' });
        else labels.push(token.literal);
      } else if (token.kind === 'ident') labels.push(token.text);
      else
        this.errors.push({
          line: token.line,
          message: `unexpected ${TOKEN_KIND_NAME[token.kind]} in block header` as const,
        });
      this.i += 1;
    }
    this.i += 1;
    if (depth >= MAX_NESTING_DEPTH) {
      // The whole rest of the token stream is left unread; no "unclosed" error follows for it.
      refuseNesting(this.nesting, typeToken.line);
      this.nesting.abandoned = true;
      this.i = this.tokens.length;
      return { type: typeToken.text, labels, line: typeToken.line, attributes: {}, blocks: [] };
    }
    const body = this.parseBody('}', depth + 1);
    return { type: typeToken.text, labels, line: typeToken.line, ...body };
  }

  /** Value tokens up to a newline (or `,` / `}` inside an object) at bracket depth 0. */
  private parseAttributeValue(nameToken: Token, inObject: boolean, depth: number): HclAttribute {
    const first = this.peek();
    const startIndex = this.i;
    let brackets = 0;
    for (;;) {
      const token = this.peek();
      if (token === undefined) break;
      if (brackets === 0 && token.kind === 'newline') break;
      if (
        brackets === 0 &&
        token.kind === 'punct' &&
        (token.text === '}' || (inObject && token.text === ','))
      )
        break;
      if (token.kind === 'punct' && OPEN.has(token.text)) brackets += 1;
      if (token.kind === 'punct' && CLOSE.has(token.text)) brackets -= 1;
      this.i += 1;
    }
    const valueTokens = this.tokens.slice(startIndex, this.i).filter((t) => t.kind !== 'newline');
    const last = valueTokens[valueTokens.length - 1];
    const raw =
      first === undefined || last === undefined ? '' : this.src.slice(first.start, last.end).trim();
    if (valueTokens.length === 0)
      this.errors.push({ line: nameToken.line, message: 'attribute has no value' });
    const only = valueTokens.length === 1 ? valueTokens[0] : undefined;
    return {
      name: nameToken.text,
      line: nameToken.line,
      raw,
      string: only !== undefined && only.kind === 'string' ? only.literal : null,
      object: this.parseObject(valueTokens, depth),
    };
  }

  /**
   * Parse `{ k = v, k2: v2 }` value tokens into entries; null for anything else, and for an object
   * nested past MAX_NESTING_DEPTH (the file then carries the nesting error; its raw text stays).
   */
  private parseObject(
    valueTokens: readonly Token[],
    depth: number,
  ): Record<string, HclAttribute> | null {
    const open = valueTokens[0];
    const close = valueTokens[valueTokens.length - 1];
    if (open === undefined || close === undefined || open.text !== '{' || close.text !== '}')
      return null;
    const firstInner = valueTokens[1];
    if (firstInner !== undefined && firstInner.kind === 'ident' && firstInner.text === 'for')
      return null;
    if (depth >= MAX_NESTING_DEPTH) {
      refuseNesting(this.nesting, open.line);
      return null;
    }
    const inner = this.tokens.slice(this.tokens.indexOf(open) + 1, this.tokens.indexOf(close));
    const sub = new Parser(this.src, inner, [], this.nesting);
    return sub.parseObjectEntries(depth + 1);
  }

  private parseObjectEntries(depth: number): Record<string, HclAttribute> | null {
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
      // A quoted key that is a template is computed when Terraform evaluates the object; this
      // reader does not, so the object has no entries it can read.
      const name = key.kind === 'string' ? key.literal : key.kind === 'ident' ? key.text : null;
      if (name === null || sep === undefined || (sep.text !== '=' && sep.text !== ':')) {
        return null;
      }
      this.i += 2;
      entries[name] = { ...this.parseAttributeValue(key, true, depth), name };
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

export function readHclBlocks(text: string): HclRead {
  const lexer = new Lexer(text);
  const errors = [...lexer.errors];
  const nesting: Nesting = { errors, abandoned: false, reported: false };
  const parser = new Parser(text, lexer.tokens, errors, nesting);
  const body = parser.parseBody(null, 0);
  return { attributes: body.attributes, blocks: body.blocks, errors };
}
