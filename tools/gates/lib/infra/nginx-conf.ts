/**
 * nginx configuration reader: a directive tree (ARIA-HIGH-012).
 *
 * WHY a tokenizer: brace counting over raw text breaks on a `{` inside a quoted `return`
 * body, a `;` inside a quoted header value, `${var}` variables and `#` comments. This reader
 * follows nginx's own lexer rules (ngx_conf_read_token): `#` starts a comment only at the
 * start of a token, single and double quotes group an argument and honour backslash escapes,
 * `${name}` is part of a word, and every directive ends in `;` or opens a `{}` block.
 */
import { MAX_NESTING_DEPTH, nestingError, type ReadError } from './read-error';

export interface NginxDirective {
  readonly name: string;
  readonly args: readonly string[];
  /** 1-based line of the directive name. */
  readonly line: number;
  /** Child directives for a block directive, null for a simple one. */
  readonly block: readonly NginxDirective[] | null;
}

export interface NginxRead {
  readonly tree: readonly NginxDirective[];
  readonly errors: readonly ReadError[];
}

type Token = {
  readonly kind: 'word' | ';' | '{' | '}';
  readonly text: string;
  readonly line: number;
};

/**
 * The only characters nginx's lexer treats as whitespace (ngx_conf_read_token: space, tab, CR,
 * LF). A BOM, a no-break space or a form feed is part of a word, as it is for nginx. Both the
 * separator scan and the word scan read this one set, so a character can never be "not a
 * separator" to one and "a word end" to the other (which made the word scan consume nothing
 * and the tokenizer loop forever).
 */
function isNginxSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\r' || c === '\n';
}

function tokenize(text: string, errors: ReadError[]): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === '\n') {
      line += 1;
      i += 1;
    } else if (isNginxSpace(c)) {
      i += 1;
    } else if (c === '#') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (c === ';' || c === '{' || c === '}') {
      tokens.push({ kind: c, text: c, line });
      i += 1;
    } else if (c === '"' || c === "'") {
      const start = line;
      let value = '';
      i += 1;
      let closed = false;
      while (i < text.length) {
        const d = text.charAt(i);
        if (d === '\\' && i + 1 < text.length) {
          const e = text.charAt(i + 1);
          value += e === c || e === '\\' ? e : `\\${e}`;
          i += 2;
          continue;
        }
        if (d === c) {
          closed = true;
          i += 1;
          break;
        }
        if (d === '\n') line += 1;
        value += d;
        i += 1;
      }
      if (!closed) errors.push({ line: start, message: 'unterminated quoted string' });
      tokens.push({ kind: 'word', text: value, line: start });
    } else {
      let value = '';
      while (i < text.length) {
        const d = text.charAt(i);
        if (d === '$' && text[i + 1] === '{') {
          const close = text.indexOf('}', i);
          const end = close < 0 ? text.length : close + 1;
          value += text.slice(i, end);
          i = end;
          continue;
        }
        if (isNginxSpace(d) || d === ';' || d === '{' || d === '}') break;
        if (d === '\\' && i + 1 < text.length) {
          value += text.slice(i, i + 2);
          i += 2;
          continue;
        }
        value += d;
        i += 1;
      }
      tokens.push({ kind: 'word', text: value, line });
    }
  }
  return tokens;
}

export function readNginx(text: string): NginxRead {
  const errors: ReadError[] = [];
  const tokens = tokenize(text, errors);
  let i = 0;
  // Set once a block past MAX_NESTING_DEPTH stopped the read: the unread rest is not "unclosed".
  let abandoned = false;

  function reportUnterminated(words: readonly Token[]): void {
    const [head] = words;
    if (head !== undefined) errors.push({ line: head.line, message: 'directive has no ; or {' });
  }

  /** `depth` counts the blocks around this one (0 at the top level). */
  function parseBlock(closing: boolean, openLine: number, depth: number): NginxDirective[] {
    const out: NginxDirective[] = [];
    let words: Token[] = [];
    for (;;) {
      const token = tokens[i];
      if (token === undefined) {
        if (!abandoned) {
          reportUnterminated(words);
          if (closing) errors.push({ line: openLine, message: 'block is not closed' });
        }
        return out;
      }
      i += 1;
      if (token.kind === 'word') {
        words.push(token);
      } else if (token.kind === ';') {
        const [head, ...rest] = words;
        if (head === undefined) errors.push({ line: token.line, message: 'empty directive' });
        else
          out.push({
            name: head.text,
            args: rest.map((w) => w.text),
            line: head.line,
            block: null,
          });
        words = [];
      } else if (token.kind === '{') {
        if (depth >= MAX_NESTING_DEPTH) {
          errors.push(nestingError(token.line));
          abandoned = true;
          i = tokens.length;
          return out;
        }
        const [head, ...rest] = words;
        words = [];
        const block = parseBlock(true, token.line, depth + 1);
        if (head === undefined)
          errors.push({ line: token.line, message: 'block without a directive name' });
        else out.push({ name: head.text, args: rest.map((w) => w.text), line: head.line, block });
      } else {
        reportUnterminated(words);
        if (!closing) {
          errors.push({ line: token.line, message: 'unexpected }' });
          words = [];
          continue;
        }
        return out;
      }
    }
  }

  const tree = parseBlock(false, 1, 0);
  return { tree, errors };
}
