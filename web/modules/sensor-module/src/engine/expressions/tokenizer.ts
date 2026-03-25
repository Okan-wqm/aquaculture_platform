/**
 * Lexical tokenizer for the SCADA expression language.
 * Converts a raw expression string into a stream of typed tokens.
 *
 * Security: This is the first defense layer — only recognized token
 * patterns are accepted. Unknown characters produce error tokens
 * that halt parsing. No arbitrary string evaluation, no regex with
 * unbounded backtracking.
 *
 * Supported tokens:
 * - Numbers: integer and float (1, 3.14, .5)
 * - Identifiers: tag names and function names ([a-zA-Z_][a-zA-Z0-9_.]*)
 * - Tag references: ${tagName} syntax for explicit tag resolution
 * - Operators: + - * / % ** == != < > <= >= && || !
 * - Grouping: ( ) ,
 * - Ternary: ? :
 */

export type TokenType =
  | 'number'
  | 'identifier'
  | 'tagRef'
  | 'operator'
  | 'leftParen'
  | 'rightParen'
  | 'comma'
  | 'question'
  | 'colon'
  | 'eof'
  | 'error';

export interface Token {
  type: TokenType;
  value: string;
  /** Character position in the original input string (zero-based) */
  position: number;
}

/**
 * Two-character operators that must be checked before their single-char
 * prefixes. Order matters: '**' before '*', '<=' before '<', etc.
 */
const TWO_CHAR_OPERATORS: ReadonlySet<string> = new Set([
  '**', '==', '!=', '<=', '>=', '&&', '||',
]);

const SINGLE_CHAR_OPERATORS: ReadonlySet<string> = new Set([
  '+', '-', '*', '/', '%', '<', '>', '!',
]);

/**
 * Tokenize an expression string into a flat array of tokens.
 *
 * The tokenizer is a single-pass scanner with no recursion and no
 * backtracking — O(n) in the length of the input. It produces an
 * 'eof' sentinel at the end so the parser always has a safe lookahead.
 *
 * Negative number literals are NOT handled here — the parser treats
 * a leading '-' as a unary operator. This avoids ambiguity between
 * subtraction and negation (e.g., `3-2` vs `3 + -2`).
 */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  const len = input.length;

  while (pos < len) {
    const ch = input[pos];

    // Skip whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      pos++;
      continue;
    }

    // Tag reference: ${tagName}
    if (ch === '$' && pos + 1 < len && input[pos + 1] === '{') {
      const startPos = pos;
      pos += 2; // skip ${
      const nameStart = pos;

      while (pos < len && input[pos] !== '}') {
        const c = input[pos];
        // Allow alphanumeric, underscore, dot, hyphen, colon, slash in tag names
        if (/[a-zA-Z0-9_.\-:/]/.test(c)) {
          pos++;
        } else {
          tokens.push({ type: 'error', value: `Unexpected character '${c}' in tag reference`, position: pos });
          return tokens;
        }
      }

      if (pos >= len) {
        tokens.push({ type: 'error', value: 'Unterminated tag reference — missing }', position: startPos });
        return tokens;
      }

      const name = input.slice(nameStart, pos);
      pos++; // skip closing }

      if (name.length === 0) {
        tokens.push({ type: 'error', value: 'Empty tag reference ${}', position: startPos });
        return tokens;
      }

      tokens.push({ type: 'tagRef', value: name, position: startPos });
      continue;
    }

    // Number: integer, float, or leading-dot decimal (.5)
    if (isDigit(ch) || (ch === '.' && pos + 1 < len && isDigit(input[pos + 1]))) {
      const startPos = pos;
      let hasDecimal = ch === '.';

      if (ch === '.') pos++; // leading dot

      while (pos < len && isDigit(input[pos])) pos++;

      // Decimal point (if we haven't already consumed a leading dot)
      if (!hasDecimal && pos < len && input[pos] === '.') {
        hasDecimal = true;
        pos++;
        while (pos < len && isDigit(input[pos])) pos++;
      }

      tokens.push({ type: 'number', value: input.slice(startPos, pos), position: startPos });
      continue;
    }

    // Identifier: function names or bare tag names
    if (isAlpha(ch) || ch === '_') {
      const startPos = pos;
      pos++;
      while (pos < len && isAlphaNumericOrDotUnderscore(input[pos])) pos++;
      tokens.push({ type: 'identifier', value: input.slice(startPos, pos), position: startPos });
      continue;
    }

    // Two-character operators (check before single-char)
    if (pos + 1 < len) {
      const twoChar = input.slice(pos, pos + 2);
      if (TWO_CHAR_OPERATORS.has(twoChar)) {
        tokens.push({ type: 'operator', value: twoChar, position: pos });
        pos += 2;
        continue;
      }
    }

    // Single-character operators
    if (SINGLE_CHAR_OPERATORS.has(ch)) {
      tokens.push({ type: 'operator', value: ch, position: pos });
      pos++;
      continue;
    }

    // Grouping and punctuation
    if (ch === '(') { tokens.push({ type: 'leftParen', value: '(', position: pos }); pos++; continue; }
    if (ch === ')') { tokens.push({ type: 'rightParen', value: ')', position: pos }); pos++; continue; }
    if (ch === ',') { tokens.push({ type: 'comma', value: ',', position: pos }); pos++; continue; }
    if (ch === '?') { tokens.push({ type: 'question', value: '?', position: pos }); pos++; continue; }
    if (ch === ':') { tokens.push({ type: 'colon', value: ':', position: pos }); pos++; continue; }

    // Unknown character — produce an error token and stop
    tokens.push({ type: 'error', value: `Unexpected character '${ch}' at position ${pos}`, position: pos });
    return tokens;
  }

  tokens.push({ type: 'eof', value: '', position: pos });
  return tokens;
}

// -- Character classification helpers (no regex in hot path) --

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isAlpha(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function isAlphaNumericOrDotUnderscore(ch: string): boolean {
  return isAlpha(ch) || isDigit(ch) || ch === '_' || ch === '.';
}
