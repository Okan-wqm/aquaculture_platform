/**
 * The one Rust reader for ARIA adapters (ARIA-HIGH-010).
 *
 * WHY: until this module, nothing in the repository read Rust for meaning.
 * The only tool whose scope matched `*.rs` was banned-phrase, which reads
 * text. Every Rust-aware adapter (the runtime-safety adapter, G010's Rust test
 * adjacency in test-gap) imports THIS module and `rust-cargo.ts`; a second
 * Rust lexer anywhere in tools/aria-adapters is a defect.
 *
 * WHAT, all from files, with no cargo or rustc subprocess (the adapter room
 * binds only node, and a host without Rust must still be able to read Rust):
 *
 *  - `lexRust`: code tokens plus a comment index, with nested block comments,
 *    raw/byte/C strings, char literals versus lifetimes, and exact lines.
 *    Malformed input, and delimiters nested deeper than
 *    `RUST_READER_MAX_NESTING`, are refused (`ok: false`), never half-read.
 *  - `moduleTree`: rustc's module resolution (mod-rs versus non-mod-rs files,
 *    inline modules, `#[path]`), so an out-of-line `#[cfg(test)] mod x;` makes
 *    `x.rs` test code. A `#[path]` leaving the workspace or the caller's
 *    allowed set is refused and never read.
 *  - `testSpans`: the token ranges that are tests or templates.
 *  - `classifyRustWorkspace`: the composition every adapter uses: each file's
 *    context (production, harness, upstream, unreached) and owning crate,
 *    from the crates and targets `rust-cargo.ts` reads.
 *
 * Paths are workspace-relative and POSIX throughout, so output is identical on
 * every host. All file access goes through the caller's `exists` / `allowed` /
 * `read`, which own the workspace boundary, snapshots and size budgets.
 */
import { posix } from 'node:path';

import { containedWorkspace, isWorkspaceRelativePath } from './adapter-fs';
import {
  crateTargets,
  discoverCrates,
  nearestRoot,
  resolveSourcePath,
  RUST_READER_MAX_NESTING,
  upstreamVendoredFiles,
  type RustCrate,
  type RustCrateTargets,
  type RustTargetIssue,
} from './rust-cargo';

// ---------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------

export type RustTokenKind = 'ident' | 'lifetime' | 'punct' | 'open' | 'close' | 'literal';
export type RustLiteralKind = 'str' | 'char' | 'number';

export interface RustToken {
  readonly kind: RustTokenKind;
  /** ident: the name (`r#` removed); lifetime: `'name`; punct/open/close: the symbol; literal: its source text. */
  readonly text: string;
  readonly line: number;
  readonly endLine: number;
  /** An identifier written `r#name`; it is never a keyword. */
  readonly raw: boolean;
  /** For an open or close delimiter, the index of its partner; -1 otherwise. */
  readonly match: number;
  readonly literal?: RustLiteralKind;
  /** A string literal's content: escapes decoded, raw strings verbatim. */
  readonly value?: string;
}

export interface RustComment {
  readonly line: number;
  readonly endLine: number;
  readonly text: string;
  readonly doc: boolean;
  readonly inner: boolean;
}

export type RustLexFailure =
  | 'unterminated_string'
  | 'unterminated_raw_string'
  | 'unterminated_block_comment'
  | 'bad_char_literal'
  | 'unbalanced_delimiter'
  | 'unclosed_delimiter'
  | 'unexpected_character'
  | 'nesting_too_deep';

export type RustLexResult =
  | {
      readonly ok: true;
      readonly tokens: readonly RustToken[];
      readonly comments: readonly RustComment[];
    }
  | { readonly ok: false; readonly reason: RustLexFailure; readonly line: number };

interface MutableToken {
  kind: RustTokenKind;
  text: string;
  line: number;
  endLine: number;
  raw: boolean;
  match: number;
  literal?: RustLiteralKind;
  value?: string;
}

class LexError extends Error {
  constructor(
    readonly reason: RustLexFailure,
    readonly line: number,
  ) {
    super(reason);
  }
}

const IDENT_START = /^[\p{XID_Start}_]$/u;
const IDENT_CONTINUE = /^\p{XID_Continue}$/u;
const DIGIT = /^[0-9]$/;
const JOINED_PUNCT = new Set(['::', '->', '=>']);
const SINGLE_PUNCT = new Set([...';,.:=<>!+-*/%^&|@#$?~']);
const OPEN_OF: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };
// rustc's Pattern_White_Space set; only `\n` advances the line counter.
const WHITESPACE = new Set([
  ' ',
  '\t',
  '\r',
  '\n',
  '\v',
  '\f',
  '\u0085',
  '\u200e',
  '\u200f',
  '\u2028',
  '\u2029',
]);
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  r: '\r',
  t: '\t',
  '\\': '\\',
  '0': '\0',
  "'": "'",
  '"': '"',
};

export function lexRust(source: string): RustLexResult {
  try {
    return new RustLexer(source).run();
  } catch (error) {
    if (error instanceof LexError) {
      return { ok: false, reason: error.reason, line: error.line };
    }
    throw error;
  }
}

class RustLexer {
  private readonly src: string;
  private i = 0;
  private line = 1;
  private readonly tokens: MutableToken[] = [];
  private readonly comments: RustComment[] = [];
  private readonly openStack: number[] = [];

  constructor(source: string) {
    this.src = source.startsWith('\ufeff') ? source.slice(1) : source;
  }

  run(): RustLexResult {
    const { src } = this;
    // A shebang line is not Rust; `#![attr]` at the start is.
    if (src.startsWith('#!') && !/^#!\s*\[/.test(src)) {
      const newline = src.indexOf('\n');
      this.i = newline < 0 ? src.length : newline;
    }
    while (this.i < src.length) {
      this.step();
    }
    const unclosed = this.openStack[this.openStack.length - 1];
    if (unclosed !== undefined) {
      throw new LexError('unclosed_delimiter', this.tokenAt(unclosed).line);
    }
    return { ok: true, tokens: this.tokens, comments: this.comments };
  }

  private step(): void {
    const { src } = this;
    const ch = src.charAt(this.i);
    if (ch === '\n') {
      this.line += 1;
      this.i += 1;
    } else if (WHITESPACE.has(ch)) {
      this.i += 1;
    } else if (src.startsWith('//', this.i)) {
      this.lineComment();
    } else if (src.startsWith('/*', this.i)) {
      this.blockComment();
    } else if (ch === '"') {
      this.quotedString(this.i, '');
    } else if (ch === "'") {
      this.quote(this.i, '');
    } else if (DIGIT.test(ch)) {
      this.number();
    } else if (IDENT_START.test(this.codePointAt(this.i))) {
      this.word();
    } else if (ch === '(' || ch === '[' || ch === '{') {
      // The bound makes every recursion over the tokens (inline modules, cfg
      // predicates) finite and shallow, whatever the file holds.
      if (this.openStack.length >= RUST_READER_MAX_NESTING) {
        throw new LexError('nesting_too_deep', this.line);
      }
      this.openStack.push(this.tokens.length);
      this.push({
        kind: 'open',
        text: ch,
        line: this.line,
        endLine: this.line,
        raw: false,
        match: -1,
      });
      this.i += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      this.close(ch);
    } else if (JOINED_PUNCT.has(src.slice(this.i, this.i + 2))) {
      this.push({
        kind: 'punct',
        text: src.slice(this.i, this.i + 2),
        line: this.line,
        endLine: this.line,
        raw: false,
        match: -1,
      });
      this.i += 2;
    } else if (SINGLE_PUNCT.has(ch)) {
      this.push({
        kind: 'punct',
        text: ch,
        line: this.line,
        endLine: this.line,
        raw: false,
        match: -1,
      });
      this.i += 1;
    } else {
      throw new LexError('unexpected_character', this.line);
    }
  }

  private push(token: MutableToken): void {
    this.tokens.push(token);
  }

  private tokenAt(index: number): MutableToken {
    const token = this.tokens[index];
    if (token === undefined) throw new Error(`token index out of range: ${index}`);
    return token;
  }

  private codePointAt(index: number): string {
    const point = this.src.codePointAt(index);
    return point === undefined ? '' : String.fromCodePoint(point);
  }

  private close(ch: string): void {
    const openIndex = this.openStack.pop();
    if (openIndex === undefined || this.tokenAt(openIndex).text !== OPEN_OF[ch]) {
      throw new LexError('unbalanced_delimiter', this.line);
    }
    this.tokenAt(openIndex).match = this.tokens.length;
    this.push({
      kind: 'close',
      text: ch,
      line: this.line,
      endLine: this.line,
      raw: false,
      match: openIndex,
    });
    this.i += 1;
  }

  private lineComment(): void {
    const newline = this.src.indexOf('\n', this.i);
    const end = newline < 0 ? this.src.length : newline;
    const text = this.src.slice(this.i, end).replace(/\r$/, '');
    const inner = text.startsWith('//!');
    const doc = inner || (text.startsWith('///') && !text.startsWith('////'));
    this.comments.push({ line: this.line, endLine: this.line, text, doc, inner });
    this.i = end;
  }

  private blockComment(): void {
    const { src } = this;
    const start = this.i;
    const startLine = this.line;
    let depth = 1;
    let j = this.i + 2;
    while (j < src.length && depth > 0) {
      if (src.startsWith('/*', j)) {
        depth += 1;
        j += 2;
      } else if (src.startsWith('*/', j)) {
        depth -= 1;
        j += 2;
      } else {
        if (src.charAt(j) === '\n') this.line += 1;
        j += 1;
      }
    }
    if (depth > 0) throw new LexError('unterminated_block_comment', startLine);
    const text = src.slice(start, j);
    const inner = text.startsWith('/*!');
    const doc = inner || (text.startsWith('/**') && !text.startsWith('/***') && text !== '/**/');
    this.comments.push({ line: startLine, endLine: this.line, text, doc, inner });
    this.i = j;
  }

  /** `"…"` with escapes; `quoteIndex` is the opening quote, `prefix` is `b` / `c` or empty. */
  private quotedString(quoteIndex: number, prefix: string): void {
    const { src } = this;
    const startLine = this.line;
    let value = '';
    let j = quoteIndex + 1;
    while (j < src.length) {
      const c = src.charAt(j);
      if (c === '"') {
        this.push({
          kind: 'literal',
          literal: 'str',
          text: prefix + src.slice(quoteIndex, j + 1),
          value,
          line: startLine,
          endLine: this.line,
          raw: false,
          match: -1,
        });
        this.i = j + 1;
        return;
      }
      if (c === '\\') {
        const escape = this.escape(j);
        value += escape.text;
        j = escape.next;
        continue;
      }
      if (c === '\n') this.line += 1;
      value += c;
      j += 1;
    }
    throw new LexError('unterminated_string', startLine);
  }

  /** One escape inside a string; a line-continuation escape swallows the newline and leading whitespace. */
  private escape(backslash: number): { readonly text: string; readonly next: number } {
    const { src } = this;
    const kind = src.charAt(backslash + 1);
    if (kind === '\n') {
      let j = backslash + 1;
      while (j < src.length && WHITESPACE.has(src.charAt(j))) {
        if (src.charAt(j) === '\n') this.line += 1;
        j += 1;
      }
      return { text: '', next: j };
    }
    const simple = SIMPLE_ESCAPES[kind];
    if (simple !== undefined) return { text: simple, next: backslash + 2 };
    if (kind === 'x') {
      return {
        text: String.fromCharCode(parseInt(src.slice(backslash + 2, backslash + 4), 16)),
        next: backslash + 4,
      };
    }
    const unicode =
      kind === 'u'
        ? /^u\{([0-9a-fA-F_]{1,8})\}/.exec(src.slice(backslash + 1, backslash + 13))
        : null;
    if (unicode !== null && unicode[1] !== undefined) {
      const point = parseInt(unicode[1].replace(/_/g, ''), 16);
      return {
        text: point <= 0x10ffff ? String.fromCodePoint(point) : '',
        next: backslash + 1 + unicode[0].length,
      };
    }
    return { text: kind, next: backslash + 2 };
  }

  /** At `'`: a char literal when it closes after one char or one escape, otherwise a lifetime or label. */
  private quote(quoteIndex: number, prefix: string): void {
    const { src } = this;
    const next = src.charAt(quoteIndex + 1);
    let end: number;
    if (next === '\\') {
      const kind = src.charAt(quoteIndex + 2);
      if (kind === 'u') {
        const unicode = /^u\{[0-9a-fA-F_]{1,8}\}/.exec(src.slice(quoteIndex + 2, quoteIndex + 14));
        if (unicode === null) throw new LexError('bad_char_literal', this.line);
        end = quoteIndex + 2 + unicode[0].length;
      } else if (kind === 'x') {
        end = quoteIndex + 5;
      } else if (kind !== '' && kind !== '\n') {
        end = quoteIndex + 3;
      } else {
        throw new LexError('bad_char_literal', this.line);
      }
    } else {
      const point = this.codePointAt(quoteIndex + 1);
      if (point !== '' && point !== '\n' && src.charAt(quoteIndex + 1 + point.length) === "'") {
        end = quoteIndex + 1 + point.length;
      } else if (prefix === '' && IDENT_START.test(point)) {
        this.lifetime(quoteIndex);
        return;
      } else {
        throw new LexError('bad_char_literal', this.line);
      }
    }
    if (src.charAt(end) !== "'") throw new LexError('bad_char_literal', this.line);
    this.push({
      kind: 'literal',
      literal: 'char',
      text: prefix + src.slice(quoteIndex, end + 1),
      line: this.line,
      endLine: this.line,
      raw: false,
      match: -1,
    });
    this.i = end + 1;
  }

  private lifetime(quoteIndex: number): void {
    let j = quoteIndex + 1;
    if (this.src.startsWith('r#', j) && IDENT_START.test(this.codePointAt(j + 2))) j += 2;
    const nameStart = j;
    j = this.identEnd(j);
    this.push({
      kind: 'lifetime',
      text: `'${this.src.slice(nameStart, j)}`,
      line: this.line,
      endLine: this.line,
      raw: false,
      match: -1,
    });
    this.i = j;
  }

  private identEnd(start: number): number {
    let j = start;
    while (j < this.src.length) {
      const point = this.codePointAt(j);
      if (!IDENT_CONTINUE.test(point)) break;
      j += point.length;
    }
    return j;
  }

  private number(): void {
    const { src } = this;
    const start = this.i;
    const radix = src.charAt(start) === '0' && /[xob]/.test(src.charAt(start + 1));
    let j = start;
    let sawDot = false;
    while (j < src.length) {
      const c = src.charAt(j);
      if (/[0-9A-Za-z_]/.test(c)) {
        if (
          !radix &&
          (c === 'e' || c === 'E') &&
          /[+-]/.test(src.charAt(j + 1)) &&
          DIGIT.test(src.charAt(j + 2))
        ) {
          j += 3;
        } else {
          j += 1;
        }
      } else if (c === '.' && !sawDot && !radix && DIGIT.test(src.charAt(j + 1))) {
        sawDot = true;
        j += 1;
      } else {
        break;
      }
    }
    this.push({
      kind: 'literal',
      literal: 'number',
      text: src.slice(start, j),
      line: this.line,
      endLine: this.line,
      raw: false,
      match: -1,
    });
    this.i = j;
  }

  /** An identifier, a raw identifier, or a prefixed literal (`b"…"`, `br#"…"#`, `c"…"`, `cr"…"`, `b'…'`). */
  private word(): void {
    const { src } = this;
    const start = this.i;
    const end = this.identEnd(start);
    const word = src.slice(start, end);
    const after = src.charAt(end);
    if (word === 'r' && after === '#' && IDENT_START.test(this.codePointAt(end + 1))) {
      const rawEnd = this.identEnd(end + 1);
      this.push({
        kind: 'ident',
        text: src.slice(end + 1, rawEnd),
        line: this.line,
        endLine: this.line,
        raw: true,
        match: -1,
      });
      this.i = rawEnd;
    } else if (
      (word === 'r' || word === 'br' || word === 'cr') &&
      (after === '"' || after === '#')
    ) {
      this.rawString(start, end);
    } else if ((word === 'b' || word === 'c') && after === '"') {
      this.quotedString(end, word);
    } else if (word === 'b' && after === "'") {
      this.quote(end, word);
    } else {
      this.push({
        kind: 'ident',
        text: word,
        line: this.line,
        endLine: this.line,
        raw: false,
        match: -1,
      });
      this.i = end;
    }
  }

  private rawString(start: number, hashStart: number): void {
    const { src } = this;
    const startLine = this.line;
    let j = hashStart;
    while (src.charAt(j) === '#') j += 1;
    if (src.charAt(j) !== '"') throw new LexError('unterminated_raw_string', startLine);
    const closer = `"${'#'.repeat(j - hashStart)}`;
    const close = src.indexOf(closer, j + 1);
    if (close < 0) throw new LexError('unterminated_raw_string', startLine);
    const value = src.slice(j + 1, close);
    this.line += value.split('\n').length - 1;
    this.push({
      kind: 'literal',
      literal: 'str',
      text: src.slice(start, close + closer.length),
      value,
      line: startLine,
      endLine: this.line,
      raw: false,
      match: -1,
    });
    this.i = close + closer.length;
  }
}

// ---------------------------------------------------------------------------
// token helpers and attributes
// ---------------------------------------------------------------------------

function isIdent(tokens: readonly RustToken[], index: number, text: string): boolean {
  const token = tokens[index];
  return token !== undefined && token.kind === 'ident' && !token.raw && token.text === text;
}

function isPunct(tokens: readonly RustToken[], index: number, text: string): boolean {
  const token = tokens[index];
  return token !== undefined && token.kind === 'punct' && token.text === text;
}

function openAt(tokens: readonly RustToken[], index: number, text: string): RustToken | undefined {
  const token = tokens[index];
  return token !== undefined && token.kind === 'open' && token.text === text ? token : undefined;
}

/** An attribute `#[…]` (outer) or `#![…]` (inner): `hash` is the `#`, `open`/`close` the brackets. */
export interface RustAttribute {
  readonly hash: number;
  readonly open: number;
  readonly close: number;
  readonly inner: boolean;
}

export function attributeAt(
  tokens: readonly RustToken[],
  index: number,
): RustAttribute | undefined {
  if (!isPunct(tokens, index, '#')) return undefined;
  const inner = isPunct(tokens, index + 1, '!');
  const openIndex = index + (inner ? 2 : 1);
  const open = openAt(tokens, openIndex, '[');
  return open === undefined
    ? undefined
    : { hash: index, open: openIndex, close: open.match, inner };
}

interface AttributeMeta {
  readonly path: readonly string[];
  /** Index of the `(` after the path, or -1. */
  readonly args: number;
  /** The token after `=`, for `#[name = value]`. */
  readonly value: RustToken | undefined;
}

function attributeMeta(tokens: readonly RustToken[], attribute: RustAttribute): AttributeMeta {
  let k = attribute.open + 1;
  const path: string[] = [];
  if (isPunct(tokens, k, '::')) k += 1;
  while (k < attribute.close) {
    const token = tokens[k];
    if (token === undefined || token.kind !== 'ident') break;
    path.push(token.text);
    k += 1;
    if (!isPunct(tokens, k, '::')) break;
    k += 1;
  }
  const args = openAt(tokens, k, '(') === undefined ? -1 : k;
  const value = args < 0 && isPunct(tokens, k, '=') ? tokens[k + 1] : undefined;
  return { path, args, value };
}

type CfgPredicate =
  | { readonly kind: 'option'; readonly name: string; readonly valued: boolean }
  | { readonly kind: 'all' | 'any' | 'not'; readonly args: readonly CfgPredicate[] }
  | { readonly kind: 'unknown' };

function parseCfgList(tokens: readonly RustToken[], start: number, end: number): CfgPredicate[] {
  const predicates: CfgPredicate[] = [];
  let k = start;
  while (k < end) {
    if (isPunct(tokens, k, ',')) {
      k += 1;
      continue;
    }
    const token = tokens[k];
    const group = openAt(tokens, k + 1, '(');
    if (token !== undefined && token.kind === 'ident' && group !== undefined) {
      const args = parseCfgList(tokens, k + 2, group.match);
      predicates.push(
        token.text === 'all' || token.text === 'any' || token.text === 'not'
          ? { kind: token.text, args }
          : { kind: 'unknown' },
      );
      k = group.match + 1;
    } else if (token !== undefined && token.kind === 'ident') {
      const valued = isPunct(tokens, k + 1, '=');
      predicates.push({ kind: 'option', name: token.text, valued });
      k += valued ? 3 : 1;
    } else {
      predicates.push({ kind: 'unknown' });
      while (k < end && !isPunct(tokens, k, ',')) k += 1;
    }
  }
  return predicates;
}

/** Sound, not complete: true only when every configuration satisfying `p` has `test` set. */
function impliesTest(p: CfgPredicate): boolean {
  switch (p.kind) {
    case 'option':
      return p.name === 'test' && !p.valued;
    case 'all':
      return p.args.some(impliesTest);
    case 'any':
      return p.args.length > 0 && p.args.every(impliesTest);
    case 'not':
      return p.args.length === 1 && p.args.every(impliesNotTest);
    case 'unknown':
      return false;
  }
}

function impliesNotTest(p: CfgPredicate): boolean {
  switch (p.kind) {
    case 'option':
      return false;
    case 'all':
      return p.args.some(impliesNotTest);
    case 'any':
      return p.args.length > 0 && p.args.every(impliesNotTest);
    case 'not':
      return p.args.length === 1 && p.args.every(impliesTest);
    case 'unknown':
      return false;
  }
}

/** `#[cfg(P)]` / `#![cfg(P)]` where P requires `test`: `cfg(any(test, x))` and `cfg(not(test))` do not. */
export function attributeGatesTest(
  tokens: readonly RustToken[],
  attribute: RustAttribute,
): boolean {
  const meta = attributeMeta(tokens, attribute);
  const group = tokens[meta.args];
  if (meta.path.length !== 1 || meta.path[0] !== 'cfg' || group === undefined) return false;
  const predicates = parseCfgList(tokens, meta.args + 1, group.match);
  return predicates.length === 1 && predicates.every(impliesTest);
}

/** `#[test]` or `#[<path>::test]` / `#[<path>::test(…)]` (tokio, async-std, …). */
export function attributeMarksTestFn(
  tokens: readonly RustToken[],
  attribute: RustAttribute,
): boolean {
  const meta = attributeMeta(tokens, attribute);
  if (meta.path.length === 1)
    return meta.path[0] === 'test' && meta.args < 0 && meta.value === undefined;
  return meta.path.length > 1 && meta.path[meta.path.length - 1] === 'test';
}

/** The string of `#[path = "…"]`, if this attribute is one. */
export function attributePathValue(
  tokens: readonly RustToken[],
  attribute: RustAttribute,
): string | undefined {
  const meta = attributeMeta(tokens, attribute);
  const value = meta.value;
  if (
    meta.path.length !== 1 ||
    meta.path[0] !== 'path' ||
    value === undefined ||
    value.literal !== 'str'
  )
    return undefined;
  return value.value;
}

function attributeIsConditionalPath(
  tokens: readonly RustToken[],
  attribute: RustAttribute,
): boolean {
  const meta = attributeMeta(tokens, attribute);
  const group = tokens[meta.args];
  if (meta.path.length !== 1 || meta.path[0] !== 'cfg_attr' || group === undefined) return false;
  for (let k = meta.args + 1; k < group.match; k += 1) {
    if (isIdent(tokens, k, 'path') && isPunct(tokens, k + 1, '=')) return true;
  }
  return false;
}

/** Whether the scope `[start, end)` carries an inner `#![cfg(test…)]` at its own level. */
function scopeGatedToTest(tokens: readonly RustToken[], start: number, end: number): boolean {
  let k = start;
  while (k < end) {
    const attribute = attributeAt(tokens, k);
    if (attribute !== undefined) {
      if (attribute.inner && attributeGatesTest(tokens, attribute)) return true;
      k = attribute.close + 1;
      continue;
    }
    const token = tokens[k];
    k = token !== undefined && token.kind === 'open' ? token.match + 1 : k + 1;
  }
  return false;
}

// ---------------------------------------------------------------------------
// test spans
// ---------------------------------------------------------------------------

export type RustTestSpanKind = 'cfg_test' | 'test_fn' | 'macro_rules';

/** Token range `[start, end]` (inclusive) holding test-only code or a macro template. */
export interface RustTestSpan {
  readonly kind: RustTestSpanKind;
  readonly start: number;
  readonly end: number;
  readonly startLine: number;
  readonly endLine: number;
}

const BRACE_ITEM_KEYWORDS = new Set([
  'fn',
  'impl',
  'trait',
  'mod',
  'struct',
  'enum',
  'union',
  'macro_rules',
]);
const SEMI_ITEM_KEYWORDS = new Set(['use', 'static', 'type', 'let']);
const ITEM_QUALIFIERS = new Set([
  'pub',
  'default',
  'unsafe',
  'async',
  'const',
  'auto',
  'safe',
  'extern',
]);

// Expressions with a block (Reference: ExpressionWithBlock) that open a statement.
const BLOCK_EXPRESSION_KEYWORDS = new Set(['if', 'match', 'loop', 'while', 'for']);

/**
 * How the attributed thing ends: `brace_or_semi` an item body or `;`, `semi`
 * a `;`, `block` the block of a block expression or braced macro call
 * (`{ … }`, `unsafe { … }`, `if`/`match`/loops, `path! { … }`), and
 * `expression` (fields, arms, expressions) a `;` or `,`.
 */
type ItemShape = 'brace_or_semi' | 'semi' | 'block' | 'expression';

/** `path! { … }` at `start`: a braced macro call, an item or statement that needs no `;`. */
function bracedMacroCallAt(tokens: readonly RustToken[], start: number): boolean {
  let k = isPunct(tokens, start, '::') ? start + 1 : start;
  for (;;) {
    const token = tokens[k];
    if (token === undefined || token.kind !== 'ident') return false;
    k += 1;
    if (!isPunct(tokens, k, '::')) break;
    k += 1;
  }
  return isPunct(tokens, k, '!') && openAt(tokens, k + 1, '{') !== undefined;
}

/** After a block: `else`, `.` and `?` continue the expression (rustc parses them even after a block-like expression). */
function continuesAfterBlock(tokens: readonly RustToken[], index: number): boolean {
  return (
    isIdent(tokens, index, 'else') || isPunct(tokens, index, '.') || isPunct(tokens, index, '?')
  );
}

/** How the attributed thing at `start` ends (see ItemShape). */
function itemShape(tokens: readonly RustToken[], start: number, limit: number): ItemShape {
  let k = start;
  let afterExtern = false;
  while (k < limit) {
    const token = tokens[k];
    if (token === undefined) break;
    if (token.kind === 'ident' && !token.raw) {
      if (BRACE_ITEM_KEYWORDS.has(token.text)) return 'brace_or_semi';
      if (SEMI_ITEM_KEYWORDS.has(token.text)) return 'semi';
      if (token.text === 'extern' && isIdent(tokens, k + 1, 'crate')) return 'semi';
      if (BLOCK_EXPRESSION_KEYWORDS.has(token.text)) return 'block';
      if (token.text === 'const' && openAt(tokens, k + 1, '{') !== undefined) return 'block';
      const nextIsFnQualifier = ['fn', 'unsafe', 'async', 'extern'].some((text) =>
        isIdent(tokens, k + 1, text),
      );
      if (token.text === 'const' && !nextIsFnQualifier) return 'semi';
      if (ITEM_QUALIFIERS.has(token.text)) {
        afterExtern = token.text === 'extern';
        const visibility = token.text === 'pub' ? openAt(tokens, k + 1, '(') : undefined;
        k = visibility === undefined ? k + 1 : visibility.match + 1;
        continue;
      }
    }
    if (afterExtern && token.kind === 'literal') {
      k += 1;
      continue;
    }
    if (token.kind === 'open' && token.text === '{') return afterExtern ? 'brace_or_semi' : 'block';
    if (token.kind === 'lifetime' && isPunct(tokens, k + 1, ':')) return 'block';
    if (bracedMacroCallAt(tokens, k)) return 'block';
    return 'expression';
  }
  return 'expression';
}

/**
 * The last token of the attributed thing at `start`. A block expression, a
 * braced macro call and a match arm whose body is one of them end at that
 * block, unless `else`, `.` or `?` continues them: skipping the block and
 * running on to the next `;` or `,` would put the shipped statements or arms
 * after it into the span.
 */
function itemEnd(tokens: readonly RustToken[], start: number, limit: number): number {
  const shape = itemShape(tokens, start, limit);
  let k = start;
  while (k < limit) {
    const token = tokens[k];
    if (token === undefined) break;
    if (token.kind === 'open') {
      if (token.text === '{' && shape === 'brace_or_semi') return token.match;
      if (token.text === '{' && shape === 'block' && !continuesAfterBlock(tokens, token.match + 1))
        return token.match;
      k = token.match + 1;
      continue;
    }
    // A match arm whose body is block-like needs no `,` (one level: the body is a `block`).
    if (
      shape === 'expression' &&
      isPunct(tokens, k, '=>') &&
      itemShape(tokens, k + 1, limit) === 'block'
    )
      return itemEnd(tokens, k + 1, limit);
    if (
      token.kind === 'punct' &&
      (token.text === ';' || ((shape === 'expression' || shape === 'block') && token.text === ','))
    )
      return k;
    k += 1;
  }
  return limit - 1;
}

function testAttributeKind(
  tokens: readonly RustToken[],
  attribute: RustAttribute,
): RustTestSpanKind | undefined {
  if (attributeGatesTest(tokens, attribute)) return 'cfg_test';
  if (attributeMarksTestFn(tokens, attribute)) return 'test_fn';
  return undefined;
}

/**
 * Token ranges that are not shipped code: items under an outer
 * `#[cfg(test…)]`, `#[test]`, `#[<path>::test]`; a scope under an inner
 * `#![cfg(test)]`; and `macro_rules!` bodies (templates, not code).
 * `#![cfg_attr(not(test), …)]` and `cfg(any(test, …))` are not test gates.
 */
export function testSpans(tokens: readonly RustToken[]): readonly RustTestSpan[] {
  const spans: RustTestSpan[] = [];
  const add = (kind: RustTestSpanKind, start: number, end: number): void => {
    const first = tokens[start];
    const last = tokens[end];
    if (first === undefined || last === undefined) return;
    spans.push({ kind, start, end, startLine: first.line, endLine: last.endLine });
  };
  // Close indices of the groups the scan is inside, innermost last.
  const limits: number[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined) break;
    const limit = limits[limits.length - 1] ?? tokens.length;
    if (token.kind === 'close') {
      limits.pop();
      i += 1;
      continue;
    }
    const attribute = attributeAt(tokens, i);
    if (attribute !== undefined && attribute.inner) {
      if (attributeGatesTest(tokens, attribute)) {
        const enclosing = tokens[limit];
        add('cfg_test', enclosing === undefined ? 0 : enclosing.match + 1, limit - 1);
        i = limit;
        continue;
      }
      i = attribute.close + 1;
      continue;
    }
    if (attribute !== undefined) {
      let kind: RustTestSpanKind | undefined;
      let next: RustAttribute | undefined = attribute;
      let after = i;
      while (next !== undefined && !next.inner) {
        kind = kind ?? testAttributeKind(tokens, next);
        after = next.close + 1;
        next = attributeAt(tokens, after);
      }
      if (kind !== undefined) {
        const end = itemEnd(tokens, after, limit);
        add(kind, i, end);
        i = end + 1;
      } else {
        i = after;
      }
      continue;
    }
    if (isIdent(tokens, i, 'macro_rules') && isPunct(tokens, i + 1, '!')) {
      const nameToken = tokens[i + 2];
      const body = tokens[nameToken !== undefined && nameToken.kind === 'ident' ? i + 3 : i + 2];
      if (body !== undefined && body.kind === 'open') {
        add('macro_rules', i, body.match);
        i = body.match + 1;
        continue;
      }
    }
    if (token.kind === 'open') limits.push(token.match);
    i += 1;
  }
  return spans;
}

// ---------------------------------------------------------------------------
// module tree
// ---------------------------------------------------------------------------

export type RustModuleContext = 'production' | 'harness';

export interface RustModuleIo {
  /** Whether a workspace-relative entry exists (called only for paths passing `isWorkspaceRelativePath`). */
  readonly exists: (path: string) => boolean;
  /** Whether the caller may read it (allowed_read_globs, snapshot, budget). */
  readonly allowed: (path: string) => boolean;
  readonly lex: (path: string) => RustLexResult;
}

export type RustModuleIssueReason =
  | 'module_missing'
  | 'module_ambiguous'
  | 'module_path_conditional'
  | 'module_path_invalid'
  | 'parse_failed';

export interface RustModuleIssue {
  readonly reason: RustModuleIssueReason;
  /** The declaring file (for parse_failed: the file that failed). */
  readonly path: string;
  readonly line: number;
  readonly detail: string;
}

export interface RustModuleTree {
  readonly files: ReadonlyMap<string, RustModuleContext>;
  /** Module paths outside the workspace (absolute ones included), behind a symlink, or outside the allowed set: never read. */
  readonly refused: readonly string[];
  readonly issues: readonly RustModuleIssue[];
}

/**
 * The one precedence rule for a file reached more than once: production is
 * the stronger fact, because a file compiled into a shipped target is shipped
 * code even when a test also compiles it. Used inside one module tree and
 * when merging the trees of a workspace's targets.
 */
function strongerContext(
  known: RustModuleContext | undefined,
  next: RustModuleContext,
): RustModuleContext {
  return known === 'production' ? known : next;
}

/** A control character (U+0000-U+001F, U+007F) in a `#[path]` value: no file path rustc can load. */
function hasControlCharacter(value: string): boolean {
  return [...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);
}

/** rustc's module directory state: `relative` is set inside a non-mod-rs file (`a/b.rs` nests under `a/b/`). */
interface ModuleScope {
  readonly dir: string;
  readonly relative: string | null;
  readonly context: RustModuleContext;
}

interface PendingFile {
  readonly path: string;
  readonly scope: ModuleScope;
}

/**
 * Every file reachable from a crate root through `mod` declarations, with
 * rustc's resolution: a mod-rs file (crate root, `mod.rs`, any `#[path]` file)
 * resolves `mod x;` to `dir/x.rs` or `dir/x/mod.rs`; a non-mod-rs file
 * `a/b.rs` to `a/b/x.rs` or `a/b/x/mod.rs`; inline `mod m { … }` nests a
 * directory; `#[path]` is relative to the declaring file's directory (inside
 * inline modules, to the inline directory), and an absolute `#[path]` is
 * itself (refused: it is outside the workspace). An edge under a cfg that
 * requires `test`, or a file / inline module with an inner `#![cfg(test)]`,
 * is harness. Declarations inside macro bodies, comments and strings are not
 * followed. A path failing `isWorkspaceRelativePath` never reaches `io`.
 */
export function moduleTree(
  root: string,
  context: RustModuleContext,
  io: RustModuleIo,
): RustModuleTree {
  const files = new Map<string, RustModuleContext>();
  const refused: string[] = [];
  const issues: RustModuleIssue[] = [];
  const issueKeys = new Set<string>();
  const queue: PendingFile[] = [];

  const addIssue = (found: RustModuleIssue): void => {
    const key = `${found.reason}:${found.path}:${found.line}:${found.detail}`;
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    issues.push(found);
  };
  const refuse = (path: string): void => {
    if (!refused.includes(path)) refused.push(path);
  };
  const status = (path: string): 'present' | 'absent' | 'refused' => {
    if (!isWorkspaceRelativePath(path)) return 'refused';
    if (!io.exists(path)) return 'absent';
    return io.allowed(path) ? 'present' : 'refused';
  };
  /** A `#[path]` value resolved like rustc, or undefined (and an issue) when it holds a control character. */
  const pathOf = (
    declaring: string,
    line: number,
    dir: string,
    value: string,
  ): string | undefined => {
    if (!hasControlCharacter(value)) return resolveSourcePath(dir, value);
    addIssue({
      reason: 'module_path_invalid',
      path: declaring,
      line,
      detail: JSON.stringify(value),
    });
    return undefined;
  };

  const declare = (
    declaring: string,
    line: number,
    name: string,
    pathAttribute: string | undefined,
    scope: ModuleScope,
    childContext: RustModuleContext,
  ): void => {
    if (pathAttribute !== undefined) {
      const path = pathOf(declaring, line, scope.dir, pathAttribute);
      if (path === undefined) return;
      const found = status(path);
      if (found === 'refused') refuse(path);
      if (found === 'absent')
        addIssue({ reason: 'module_missing', path: declaring, line, detail: path });
      if (found === 'present')
        queue.push({
          path,
          scope: { dir: posix.dirname(path), relative: null, context: childContext },
        });
      return;
    }
    const base = scope.relative === null ? scope.dir : posix.join(scope.dir, scope.relative);
    const flat = posix.join(base, `${name}.rs`);
    const nested = posix.join(base, name, 'mod.rs');
    const flatStatus = status(flat);
    const nestedStatus = status(nested);
    if (flatStatus === 'present' && nestedStatus === 'present') {
      addIssue({
        reason: 'module_ambiguous',
        path: declaring,
        line,
        detail: `${flat} | ${nested}`,
      });
    } else if (flatStatus === 'present') {
      queue.push({ path: flat, scope: { dir: base, relative: name, context: childContext } });
    } else if (nestedStatus === 'present') {
      queue.push({
        path: nested,
        scope: { dir: posix.join(base, name), relative: null, context: childContext },
      });
    } else if (flatStatus === 'refused' || nestedStatus === 'refused') {
      refuse(flatStatus === 'refused' ? flat : nested);
    } else {
      addIssue({ reason: 'module_missing', path: declaring, line, detail: `${flat} | ${nested}` });
    }
  };

  const walkScope = (
    tokens: readonly RustToken[],
    start: number,
    end: number,
    scope: ModuleScope,
    file: string,
  ): void => {
    let pending: RustAttribute[] = [];
    let k = start;
    while (k < end) {
      const attribute = attributeAt(tokens, k);
      if (attribute !== undefined) {
        if (!attribute.inner) pending.push(attribute);
        k = attribute.close + 1;
        continue;
      }
      const token = tokens[k];
      if (token === undefined) break;
      const nameToken = tokens[k + 1];
      if (isIdent(tokens, k, 'mod') && nameToken !== undefined && nameToken.kind === 'ident') {
        const childContext =
          scope.context === 'harness' || pending.some((a) => attributeGatesTest(tokens, a))
            ? 'harness'
            : 'production';
        const pathAttribute = pending
          .map((a) => attributePathValue(tokens, a))
          .find((value) => value !== undefined);
        if (pending.some((a) => attributeIsConditionalPath(tokens, a))) {
          addIssue({
            reason: 'module_path_conditional',
            path: file,
            line: token.line,
            detail: nameToken.text,
          });
        }
        pending = [];
        if (isPunct(tokens, k + 2, ';')) {
          declare(file, token.line, nameToken.text, pathAttribute, scope, childContext);
          k += 3;
          continue;
        }
        const body = openAt(tokens, k + 2, '{');
        if (body !== undefined) {
          const dir =
            pathAttribute !== undefined
              ? pathOf(file, token.line, scope.dir, pathAttribute)
              : posix.join(
                  scope.relative === null ? scope.dir : posix.join(scope.dir, scope.relative),
                  nameToken.text,
                );
          // An invalid `#[path]` (reported by pathOf) gives the inline module
          // no directory, so none of its out-of-line children can be resolved.
          if (dir === undefined) {
            k = body.match + 1;
            continue;
          }
          const innerContext = scopeGatedToTest(tokens, k + 3, body.match)
            ? 'harness'
            : childContext;
          walkScope(
            tokens,
            k + 3,
            body.match,
            { dir, relative: null, context: innerContext },
            file,
          );
          k = body.match + 1;
          continue;
        }
      }
      if (token.kind === 'open') {
        if (token.text === '{') pending = [];
        k = token.match + 1;
        continue;
      }
      if (token.kind === 'punct' && token.text === ';') pending = [];
      k += 1;
    }
  };

  const rootStatus = status(root);
  if (rootStatus === 'refused') refuse(root);
  if (rootStatus === 'absent')
    addIssue({ reason: 'module_missing', path: root, line: 0, detail: root });
  if (rootStatus === 'present')
    queue.push({ path: root, scope: { dir: posix.dirname(root), relative: null, context } });

  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const lexed = io.lex(next.path);
    const gated = lexed.ok && scopeGatedToTest(lexed.tokens, 0, lexed.tokens.length);
    const known = files.get(next.path);
    const fileContext = strongerContext(known, gated ? 'harness' : next.scope.context);
    // Reached again with nothing stronger: already walked (this also ends a #[path] cycle).
    if (fileContext === known) continue;
    files.set(next.path, fileContext);
    if (!lexed.ok) {
      addIssue({ reason: 'parse_failed', path: next.path, line: lexed.line, detail: lexed.reason });
      continue;
    }
    walkScope(
      lexed.tokens,
      0,
      lexed.tokens.length,
      { ...next.scope, context: fileContext },
      next.path,
    );
  }
  return { files, refused, issues };
}

// ---------------------------------------------------------------------------
// the workspace
// ---------------------------------------------------------------------------

export type RustFileContext = 'production' | 'harness' | 'upstream' | 'unreached';

export interface RustFileRecord {
  readonly path: string;
  readonly context: RustFileContext;
  /** The owning crate root by the package-root rule, or null. */
  readonly crate: string | null;
  readonly lex: RustLexResult;
}

export interface RustCrateRecord extends RustCrate {
  readonly targets: RustCrateTargets;
  readonly upstreamManifest: string | null;
}

export interface RustWorkspaceIo {
  /**
   * False only when the workspace holds no entry at the path. A path the io
   * will not look at (outside the workspace, behind a symlink) counts as
   * present, so readers record it as refused rather than missing.
   */
  readonly exists: (path: string) => boolean;
  /** Whether it may be read; `read` is called only for paths that exist and are allowed. */
  readonly allowed: (path: string) => boolean;
  readonly read: (path: string) => string;
}

/**
 * The filesystem access every Rust reader uses: adapter-fs's
 * `containedWorkspace` (the one owner of containment: a normalised relative
 * path, no symlink on any component, nothing behind a symlink examined) plus
 * the caller's `allowed` (allowed_read_globs, snapshot, budget). A symlinked
 * `mod` target or `#[path]` is refused exactly like one outside the
 * workspace, and `read` re-checks rather than trusting its caller.
 */
export function workspaceRustIo(
  workspaceRoot: string,
  allowed: (path: string) => boolean,
): RustWorkspaceIo {
  const workspace = containedWorkspace(workspaceRoot);
  return {
    exists: (path) => workspace.entry(path) !== 'absent',
    allowed: (path) => workspace.entry(path) === 'file' && allowed(path),
    read: (path) => {
      if (!allowed(path)) throw new Error(`refused Rust read: ${path}`);
      return workspace.readFile(path);
    },
  };
}

export interface RustParseFailure {
  readonly path: string;
  readonly line: number;
  readonly reason: RustLexFailure;
}

export interface RustWorkspace {
  readonly crates: readonly RustCrateRecord[];
  /** Every walked `.rs` file plus every file a module tree reached, by path. */
  readonly files: ReadonlyMap<string, RustFileRecord>;
  readonly issues: {
    readonly parseFailures: readonly RustParseFailure[];
    readonly unclassifiedTargets: readonly RustTargetIssue[];
    readonly moduleIssues: readonly RustModuleIssue[];
    readonly refused: readonly string[];
  };
  /** Every file read, for the caller's read_paths. */
  readonly readPaths: readonly string[];
}

/**
 * Each Rust file's context: `production` when a production target reaches it
 * through non-test edges (production wins over harness: a file compiled into
 * a shipped target is shipped code even when a test also includes it), then
 * `upstream` when its bytes are a vendored crate's upstream; `harness` when
 * only test, bench, example, build-script or fuzz targets or cfg(test) edges
 * reach it; `unreached` otherwise.
 */
export function classifyRustWorkspace(
  paths: readonly string[],
  io: RustWorkspaceIo,
): RustWorkspace {
  const texts = new Map<string, string>();
  const read = (path: string): string => {
    const cached = texts.get(path);
    if (cached !== undefined) return cached;
    const text = io.read(path);
    texts.set(path, text);
    return text;
  };
  const lexed = new Map<string, RustLexResult>();
  const lex = (path: string): RustLexResult => {
    const cached = lexed.get(path);
    if (cached !== undefined) return cached;
    const result = lexRust(read(path));
    lexed.set(path, result);
    return result;
  };

  const refused = new Set<string>();
  const readable = paths.filter((path) => {
    if (isWorkspaceRelativePath(path) && io.exists(path) && io.allowed(path)) return true;
    refused.add(path);
    return false;
  });
  const discovery = discoverCrates(readable, read);
  const reached = new Map<string, RustModuleContext>();
  const moduleIssues: RustModuleIssue[] = [];
  const unclassifiedTargets: RustTargetIssue[] = [];
  const upstream = new Map<string, ReadonlySet<string>>();
  const crates = discovery.crates.map((crate): RustCrateRecord => {
    const targets = crateTargets(crate, { exists: io.exists, read });
    unclassifiedTargets.push(...targets.unclassified);
    for (const root of [...targets.production, ...targets.harness]) {
      const tree = moduleTree(root.path, root.role, {
        exists: io.exists,
        allowed: io.allowed,
        lex,
      });
      for (const [path, context] of tree.files) {
        reached.set(path, strongerContext(reached.get(path), context));
      }
      tree.refused.forEach((path) => refused.add(path));
      moduleIssues.push(...tree.issues.filter((found) => found.reason !== 'parse_failed'));
    }
    const vendored = upstreamVendoredFiles(crate.root, {
      exists: io.exists,
      allowed: io.allowed,
      read,
    });
    if (vendored.refused !== null) refused.add(vendored.refused);
    upstream.set(crate.root, vendored.files);
    return { ...crate, targets, upstreamManifest: vendored.manifest };
  });

  const crateRoots = new Set(discovery.crates.map((crate) => crate.root));
  const sources = [
    ...new Set([...readable.filter((path) => path.endsWith('.rs')), ...reached.keys()]),
  ].sort();
  const files = new Map<string, RustFileRecord>();
  const parseFailures: RustParseFailure[] = [];
  for (const path of sources) {
    const result = lex(path);
    if (!result.ok) parseFailures.push({ path, line: result.line, reason: result.reason });
    const crate = nearestRoot(path, crateRoots) ?? null;
    let context: RustFileContext = reached.get(path) ?? 'unreached';
    const vendored = crate === null ? undefined : upstream.get(crate);
    if (context === 'production' && vendored !== undefined && vendored.has(path))
      context = 'upstream';
    files.set(path, { path, context, crate, lex: result });
  }

  const seenIssues = new Set<string>();
  const uniqueModuleIssues = moduleIssues.filter((found) => {
    const key = `${found.reason}:${found.path}:${found.line}:${found.detail}`;
    if (seenIssues.has(key)) return false;
    seenIssues.add(key);
    return true;
  });
  return {
    crates,
    files,
    issues: {
      parseFailures,
      unclassifiedTargets,
      moduleIssues: uniqueModuleIssues,
      refused: [...refused].sort(),
    },
    readPaths: [...texts.keys()].sort(),
  };
}
