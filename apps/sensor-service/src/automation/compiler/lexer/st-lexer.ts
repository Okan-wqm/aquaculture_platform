/**
 * IEC 61131-3 Structured Text Lexer
 *
 * Production-quality lexical analyzer supporting:
 * - All IEC 61131-3 Edition 3 keywords (case-insensitive)
 * - Numeric literals: integer, real, hex (16#), octal (8#), binary (2#), typed (INT#5)
 * - String literals: single-quoted, double-quoted, with IEC escape sequences
 * - TIME literals: T#5s, T#100ms, T#1h30m, TIME#1d2h3m4s5ms
 * - DATE literals: D#2024-01-15, DT#2024-01-15-12:30:00, TOD#12:30:00
 * - Comments: single-line (//), multi-line (* *), curly brace { }
 * - Security: source size limit, token count limit, timeout guard
 *
 * Performance target: 100KB source in < 200ms
 */

import { Token, TokenType, LexerError, LexerResult } from './st-tokens';
import { lookupKeyword } from './st-keywords';

// ────────────────────────────────────────────────────────────────────────────
// Security Constants
// ────────────────────────────────────────────────────────────────────────────

const MAX_SOURCE_SIZE = 100 * 1024;    // 100 KB
const MAX_TOKEN_COUNT = 500_000;       // 500K tokens
const TIMEOUT_MS = 5_000;             // 5 seconds

// ────────────────────────────────────────────────────────────────────────────
// Character Classification Helpers
// ────────────────────────────────────────────────────────────────────────────

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isHexDigit(ch: string): boolean {
  return (ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'F') || (ch >= 'a' && ch <= 'f');
}

function isOctalDigit(ch: string): boolean {
  return ch >= '0' && ch <= '7';
}

function isBinaryDigit(ch: string): boolean {
  return ch === '0' || ch === '1';
}

function isLetter(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z');
}

function isIdentStart(ch: string): boolean {
  return isLetter(ch) || ch === '_';
}

function isIdentPart(ch: string): boolean {
  return isLetter(ch) || isDigit(ch) || ch === '_';
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r';
}

// ────────────────────────────────────────────────────────────────────────────
// Typed literal prefix set (identifiers that become typed literals with #)
// ────────────────────────────────────────────────────────────────────────────

const TYPED_LITERAL_PREFIXES = new Set([
  'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD',
  'SINT', 'INT', 'DINT', 'LINT',
  'USINT', 'UINT', 'UDINT', 'ULINT',
  'REAL', 'LREAL',
]);

// Time/date literal prefixes (case-insensitive, checked as uppercase)
const TIME_PREFIXES = new Set(['T', 'TIME']);
const DATE_PREFIXES = new Set(['D', 'DATE']);
const DATETIME_PREFIXES = new Set(['DT', 'DATE_AND_TIME']);
const TOD_PREFIXES = new Set(['TOD', 'TIME_OF_DAY']);

// ────────────────────────────────────────────────────────────────────────────
// Lexer Implementation
// ────────────────────────────────────────────────────────────────────────────

export function tokenize(source: string): LexerResult {
  // ── Security: source size check ─────────────────────────────────────
  if (source.length > MAX_SOURCE_SIZE) {
    return {
      tokens: [],
      errors: [{
        message: `Source exceeds maximum size of ${MAX_SOURCE_SIZE} bytes (got ${source.length})`,
        line: 1,
        col: 1,
        offset: 0,
        length: 0,
      }],
    };
  }

  const tokens: Token[] = [];
  const errors: LexerError[] = [];
  const len = source.length;
  let pos = 0;
  let line = 1;
  let col = 1;
  const startTime = Date.now();

  // ── Timeout guard (checked every 4096 tokens) ──────────────────────
  let tokensSinceCheck = 0;

  function checkTimeout(): boolean {
    if (++tokensSinceCheck >= 4096) {
      tokensSinceCheck = 0;
      if (Date.now() - startTime > TIMEOUT_MS) {
        errors.push({
          message: `Lexer timeout exceeded (${TIMEOUT_MS}ms)`,
          line, col, offset: pos, length: 0,
        });
        return true;
      }
    }
    return false;
  }

  function peek(offset = 0): string {
    return pos + offset < len ? source[pos + offset] : '\0';
  }

  function advance(): string {
    const ch = source[pos];
    pos++;
    if (ch === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
    return ch;
  }

  function makeToken(type: TokenType, startPos: number, startLine: number, startCol: number): Token {
    const value = source.substring(startPos, pos);
    return { type, value, line: startLine, col: startCol, offset: startPos, length: pos - startPos };
  }

  function addError(message: string, startPos: number, startLine: number, startCol: number, length: number): void {
    errors.push({ message, line: startLine, col: startCol, offset: startPos, length });
  }

  // ── Main scan loop ─────────────────────────────────────────────────
  while (pos < len) {
    // Security: token count limit
    if (tokens.length >= MAX_TOKEN_COUNT) {
      errors.push({
        message: `Token count exceeds maximum of ${MAX_TOKEN_COUNT}`,
        line, col, offset: pos, length: 0,
      });
      break;
    }

    if (checkTimeout()) break;

    const ch = source[pos];
    const tokLine = line;
    const tokCol = col;
    const tokPos = pos;

    // ── Newline ─────────────────────────────────────────────────────
    if (ch === '\n') {
      advance();
      tokens.push(makeToken(TokenType.NEWLINE, tokPos, tokLine, tokCol));
      continue;
    }

    // ── Whitespace (non-newline) ────────────────────────────────────
    if (isWhitespace(ch)) {
      while (pos < len && isWhitespace(source[pos])) {
        advance();
      }
      tokens.push(makeToken(TokenType.WHITESPACE, tokPos, tokLine, tokCol));
      continue;
    }

    // ── Single-line comment // ──────────────────────────────────────
    if (ch === '/' && peek(1) === '/') {
      advance(); advance(); // consume //
      while (pos < len && source[pos] !== '\n') {
        advance();
      }
      tokens.push(makeToken(TokenType.COMMENT, tokPos, tokLine, tokCol));
      continue;
    }

    // ── Multi-line comment (* ... *) ────────────────────────────────
    if (ch === '(' && peek(1) === '*') {
      advance(); advance(); // consume (*
      let depth = 1;
      while (pos < len && depth > 0) {
        if (source[pos] === '(' && peek(1) === '*') {
          depth++;
          advance(); advance();
        } else if (source[pos] === '*' && peek(1) === ')') {
          depth--;
          advance(); advance();
        } else {
          advance();
        }
      }
      if (depth > 0) {
        addError('Unterminated comment (* ... *)', tokPos, tokLine, tokCol, pos - tokPos);
      }
      tokens.push(makeToken(TokenType.COMMENT, tokPos, tokLine, tokCol));
      continue;
    }

    // ── Curly brace comment { ... } ─────────────────────────────────
    if (ch === '{') {
      advance(); // consume {
      while (pos < len && source[pos] !== '}') {
        advance();
      }
      if (pos < len) {
        advance(); // consume }
      } else {
        addError('Unterminated comment { ... }', tokPos, tokLine, tokCol, pos - tokPos);
      }
      tokens.push(makeToken(TokenType.COMMENT, tokPos, tokLine, tokCol));
      continue;
    }

    // ── String literal (single-quoted) ──────────────────────────────
    if (ch === '\'') {
      advance(); // consume opening '
      while (pos < len && source[pos] !== '\'' && source[pos] !== '\n') {
        if (source[pos] === '$' && pos + 1 < len) {
          advance(); // consume $
          advance(); // consume escape char
        } else {
          advance();
        }
      }
      if (pos < len && source[pos] === '\'') {
        advance(); // consume closing '
      } else {
        addError('Unterminated string literal', tokPos, tokLine, tokCol, pos - tokPos);
      }
      tokens.push(makeToken(TokenType.STRING_LITERAL, tokPos, tokLine, tokCol));
      continue;
    }

    // ── String literal (double-quoted) ──────────────────────────────
    if (ch === '"') {
      advance(); // consume opening "
      while (pos < len && source[pos] !== '"' && source[pos] !== '\n') {
        if (source[pos] === '$' && pos + 1 < len) {
          advance(); // consume $
          advance(); // consume escape char
        } else {
          advance();
        }
      }
      if (pos < len && source[pos] === '"') {
        advance(); // consume closing "
      } else {
        addError('Unterminated string literal', tokPos, tokLine, tokCol, pos - tokPos);
      }
      tokens.push(makeToken(TokenType.STRING_LITERAL, tokPos, tokLine, tokCol));
      continue;
    }

    // ── Numeric literals (starts with digit) ────────────────────────
    if (isDigit(ch)) {
      const numResult = scanNumericLiteral(tokPos, tokLine, tokCol);
      tokens.push(numResult);
      continue;
    }

    // ── Identifiers, keywords, typed/time/date literals ─────────────
    if (isIdentStart(ch)) {
      // Scan the full identifier (including underscores between parts for END_IF etc.)
      while (pos < len && isIdentPart(source[pos])) {
        advance();
      }
      let word = source.substring(tokPos, pos);
      const wordUpper = word.toUpperCase();

      // Check for # suffix → time/date/typed literal
      if (pos < len && source[pos] === '#') {
        // TIME literal: T#..., TIME#...
        if (TIME_PREFIXES.has(wordUpper)) {
          advance(); // consume #
          scanTimeLiteralBody();
          tokens.push(makeToken(TokenType.TIME_LITERAL, tokPos, tokLine, tokCol));
          continue;
        }

        // DATE literal: D#..., DATE#...
        if (DATE_PREFIXES.has(wordUpper)) {
          advance(); // consume #
          scanDateLiteralBody();
          tokens.push(makeToken(TokenType.DATE_LITERAL, tokPos, tokLine, tokCol));
          continue;
        }

        // DATE_AND_TIME literal: DT#..., DATE_AND_TIME#...
        if (DATETIME_PREFIXES.has(wordUpper)) {
          advance(); // consume #
          scanDateTimeLiteralBody();
          tokens.push(makeToken(TokenType.DATE_LITERAL, tokPos, tokLine, tokCol));
          continue;
        }

        // TOD literal: TOD#..., TIME_OF_DAY#...
        if (TOD_PREFIXES.has(wordUpper)) {
          advance(); // consume #
          scanTodLiteralBody();
          tokens.push(makeToken(TokenType.DATE_LITERAL, tokPos, tokLine, tokCol));
          continue;
        }

        // Typed numeric literal: INT#5, REAL#3.14, etc.
        if (TYPED_LITERAL_PREFIXES.has(wordUpper)) {
          advance(); // consume #
          const innerStart = pos;
          // Scan the numeric value after #
          if (pos < len && (isDigit(source[pos]) || source[pos] === '-' || source[pos] === '+')) {
            if (source[pos] === '-' || source[pos] === '+') advance();
            while (pos < len && isDigit(source[pos])) advance();
            if (pos < len && source[pos] === '.') {
              advance();
              while (pos < len && isDigit(source[pos])) advance();
              // Exponent
              if (pos < len && (source[pos] === 'e' || source[pos] === 'E')) {
                advance();
                if (pos < len && (source[pos] === '+' || source[pos] === '-')) advance();
                while (pos < len && isDigit(source[pos])) advance();
              }
              tokens.push(makeToken(TokenType.REAL_LITERAL, tokPos, tokLine, tokCol));
            } else {
              tokens.push(makeToken(TokenType.INTEGER_LITERAL, tokPos, tokLine, tokCol));
            }
          } else if (pos < len && wordUpper === 'BOOL' && isLetter(source[pos])) {
            // BOOL#TRUE, BOOL#FALSE
            while (pos < len && isIdentPart(source[pos])) advance();
            tokens.push(makeToken(TokenType.BOOLEAN_LITERAL, tokPos, tokLine, tokCol));
          } else {
            // Consume whatever is there, emit error
            while (pos < len && !isWhitespace(source[pos]) && source[pos] !== ';' && source[pos] !== '\n') advance();
            addError('Invalid typed literal', tokPos, tokLine, tokCol, pos - tokPos);
            tokens.push(makeToken(TokenType.ERROR, tokPos, tokLine, tokCol));
          }
          continue;
        }

        // Base-prefixed numeric literal: 16#FF, 8#77, 2#1010
        if (wordUpper === '16' || wordUpper === '8' || wordUpper === '2') {
          // This case won't hit here since digits don't start with isIdentStart.
          // Handled in scanNumericLiteral instead.
        }
      }

      // Check for BOOLEAN literals
      if (wordUpper === 'TRUE' || wordUpper === 'FALSE') {
        tokens.push({ type: TokenType.BOOLEAN_LITERAL, value: word, line: tokLine, col: tokCol, offset: tokPos, length: word.length });
        continue;
      }

      // Keyword lookup (case-insensitive)
      const kwType = lookupKeyword(wordUpper);
      if (kwType !== undefined) {
        tokens.push({ type: kwType, value: word, line: tokLine, col: tokCol, offset: tokPos, length: word.length });
        continue;
      }

      // Plain identifier
      tokens.push({ type: TokenType.IDENTIFIER, value: word, line: tokLine, col: tokCol, offset: tokPos, length: word.length });
      continue;
    }

    // ── Two-character operators ──────────────────────────────────────
    if (ch === ':' && peek(1) === '=') {
      advance(); advance();
      tokens.push(makeToken(TokenType.ASSIGN, tokPos, tokLine, tokCol));
      continue;
    }
    if (ch === '=' && peek(1) === '>') {
      advance(); advance();
      tokens.push(makeToken(TokenType.OUTPUT_ASSIGN, tokPos, tokLine, tokCol));
      continue;
    }
    if (ch === '<' && peek(1) === '>') {
      advance(); advance();
      tokens.push(makeToken(TokenType.NEQ, tokPos, tokLine, tokCol));
      continue;
    }
    if (ch === '<' && peek(1) === '=') {
      advance(); advance();
      tokens.push(makeToken(TokenType.LE, tokPos, tokLine, tokCol));
      continue;
    }
    if (ch === '>' && peek(1) === '=') {
      advance(); advance();
      tokens.push(makeToken(TokenType.GE, tokPos, tokLine, tokCol));
      continue;
    }
    if (ch === '*' && peek(1) === '*') {
      advance(); advance();
      tokens.push(makeToken(TokenType.POWER, tokPos, tokLine, tokCol));
      continue;
    }
    if (ch === '.' && peek(1) === '.') {
      advance(); advance();
      tokens.push(makeToken(TokenType.DOTDOT, tokPos, tokLine, tokCol));
      continue;
    }

    // ── Single-character operators and punctuation ───────────────────
    switch (ch) {
      case '+': advance(); tokens.push(makeToken(TokenType.PLUS, tokPos, tokLine, tokCol)); continue;
      case '-': advance(); tokens.push(makeToken(TokenType.MINUS, tokPos, tokLine, tokCol)); continue;
      case '*': advance(); tokens.push(makeToken(TokenType.STAR, tokPos, tokLine, tokCol)); continue;
      case '/': advance(); tokens.push(makeToken(TokenType.SLASH, tokPos, tokLine, tokCol)); continue;
      case '=': advance(); tokens.push(makeToken(TokenType.EQ, tokPos, tokLine, tokCol)); continue;
      case '<': advance(); tokens.push(makeToken(TokenType.LT, tokPos, tokLine, tokCol)); continue;
      case '>': advance(); tokens.push(makeToken(TokenType.GT, tokPos, tokLine, tokCol)); continue;
      case '(': advance(); tokens.push(makeToken(TokenType.LPAREN, tokPos, tokLine, tokCol)); continue;
      case ')': advance(); tokens.push(makeToken(TokenType.RPAREN, tokPos, tokLine, tokCol)); continue;
      case '[': advance(); tokens.push(makeToken(TokenType.LBRACKET, tokPos, tokLine, tokCol)); continue;
      case ']': advance(); tokens.push(makeToken(TokenType.RBRACKET, tokPos, tokLine, tokCol)); continue;
      case ',': advance(); tokens.push(makeToken(TokenType.COMMA, tokPos, tokLine, tokCol)); continue;
      case ';': advance(); tokens.push(makeToken(TokenType.SEMICOLON, tokPos, tokLine, tokCol)); continue;
      case ':': advance(); tokens.push(makeToken(TokenType.COLON, tokPos, tokLine, tokCol)); continue;
      case '.': advance(); tokens.push(makeToken(TokenType.DOT, tokPos, tokLine, tokCol)); continue;
      case '#': advance(); tokens.push(makeToken(TokenType.HASH, tokPos, tokLine, tokCol)); continue;
      case '^': advance(); tokens.push(makeToken(TokenType.ARROW, tokPos, tokLine, tokCol)); continue;
    }

    // ── Unknown character → ERROR token ─────────────────────────────
    advance();
    addError(`Unexpected character '${ch}'`, tokPos, tokLine, tokCol, 1);
    tokens.push(makeToken(TokenType.ERROR, tokPos, tokLine, tokCol));
  }

  // Append EOF
  tokens.push({
    type: TokenType.EOF,
    value: '',
    line,
    col,
    offset: pos,
    length: 0,
  });

  return { tokens, errors };

  // ────────────────────────────────────────────────────────────────────
  // Numeric literal scanner
  // ────────────────────────────────────────────────────────────────────

  function scanNumericLiteral(startPos: number, startLine: number, startCol: number): Token {
    // Scan leading digits (could be base prefix like 16, 8, 2)
    while (pos < len && isDigit(source[pos])) {
      advance();
    }

    // Check for base-prefix literal: 16#FF, 8#77, 2#1010
    if (pos < len && source[pos] === '#') {
      const prefix = source.substring(startPos, pos);
      if (prefix === '16') {
        advance(); // consume #
        if (pos < len && isHexDigit(source[pos])) {
          while (pos < len && (isHexDigit(source[pos]) || source[pos] === '_')) advance();
          return makeToken(TokenType.HEX_LITERAL, startPos, startLine, startCol);
        }
        addError('Invalid hex literal', startPos, startLine, startCol, pos - startPos);
        return makeToken(TokenType.ERROR, startPos, startLine, startCol);
      }
      if (prefix === '8') {
        advance(); // consume #
        if (pos < len && isOctalDigit(source[pos])) {
          while (pos < len && (isOctalDigit(source[pos]) || source[pos] === '_')) advance();
          return makeToken(TokenType.OCTAL_LITERAL, startPos, startLine, startCol);
        }
        addError('Invalid octal literal', startPos, startLine, startCol, pos - startPos);
        return makeToken(TokenType.ERROR, startPos, startLine, startCol);
      }
      if (prefix === '2') {
        advance(); // consume #
        if (pos < len && isBinaryDigit(source[pos])) {
          while (pos < len && (isBinaryDigit(source[pos]) || source[pos] === '_')) advance();
          return makeToken(TokenType.BINARY_LITERAL, startPos, startLine, startCol);
        }
        addError('Invalid binary literal', startPos, startLine, startCol, pos - startPos);
        return makeToken(TokenType.ERROR, startPos, startLine, startCol);
      }
      // Not a recognized base prefix; treat as integer + hash
      // Backtrack: don't consume #, return integer
      return makeToken(TokenType.INTEGER_LITERAL, startPos, startLine, startCol);
    }

    // Allow underscore separators in digit sequences (e.g. 1_000_000)
    while (pos < len && source[pos] === '_' && pos + 1 < len && isDigit(source[pos + 1])) {
      advance(); // _
      while (pos < len && isDigit(source[pos])) advance();
    }

    // Real literal: decimal point followed by digits
    if (pos < len && source[pos] === '.' && pos + 1 < len && isDigit(source[pos + 1])) {
      advance(); // consume .
      while (pos < len && isDigit(source[pos])) advance();
      // Underscore separators in fractional part
      while (pos < len && source[pos] === '_' && pos + 1 < len && isDigit(source[pos + 1])) {
        advance();
        while (pos < len && isDigit(source[pos])) advance();
      }
      // Exponent part
      if (pos < len && (source[pos] === 'e' || source[pos] === 'E')) {
        advance();
        if (pos < len && (source[pos] === '+' || source[pos] === '-')) advance();
        if (pos < len && isDigit(source[pos])) {
          while (pos < len && isDigit(source[pos])) advance();
        } else {
          addError('Expected digits in exponent', startPos, startLine, startCol, pos - startPos);
        }
      }
      return makeToken(TokenType.REAL_LITERAL, startPos, startLine, startCol);
    }

    // Exponent without decimal (e.g. 5E3)
    if (pos < len && (source[pos] === 'e' || source[pos] === 'E')) {
      advance();
      if (pos < len && (source[pos] === '+' || source[pos] === '-')) advance();
      if (pos < len && isDigit(source[pos])) {
        while (pos < len && isDigit(source[pos])) advance();
        return makeToken(TokenType.REAL_LITERAL, startPos, startLine, startCol);
      }
      addError('Expected digits in exponent', startPos, startLine, startCol, pos - startPos);
      return makeToken(TokenType.ERROR, startPos, startLine, startCol);
    }

    return makeToken(TokenType.INTEGER_LITERAL, startPos, startLine, startCol);
  }

  // ────────────────────────────────────────────────────────────────────
  // Time/Date literal body scanners
  // ────────────────────────────────────────────────────────────────────

  /** Scan body of TIME literal after T# or TIME# */
  function scanTimeLiteralBody(): void {
    // TIME body: digits followed by d/h/m/s/ms units, possibly repeated
    // e.g. 1d2h3m4s500ms, 100ms, 5s, -T#5s (minus already consumed)
    if (pos < len && (source[pos] === '-' || source[pos] === '+')) advance();
    while (pos < len && (isDigit(source[pos]) || source[pos] === '.' || source[pos] === '_')) {
      advance();
      // Consume unit suffix letters
      while (pos < len && isLetter(source[pos])) advance();
    }
  }

  /** Scan body of DATE literal after D# or DATE# */
  function scanDateLiteralBody(): void {
    // DATE body: YYYY-MM-DD
    while (pos < len && (isDigit(source[pos]) || source[pos] === '-')) {
      advance();
    }
  }

  /** Scan body of DATE_AND_TIME literal after DT# or DATE_AND_TIME# */
  function scanDateTimeLiteralBody(): void {
    // DT body: YYYY-MM-DD-HH:MM:SS or YYYY-MM-DD-HH:MM:SS.sss
    while (pos < len && (isDigit(source[pos]) || source[pos] === '-' || source[pos] === ':' || source[pos] === '.')) {
      advance();
    }
  }

  /** Scan body of TOD literal after TOD# or TIME_OF_DAY# */
  function scanTodLiteralBody(): void {
    // TOD body: HH:MM:SS or HH:MM:SS.sss
    while (pos < len && (isDigit(source[pos]) || source[pos] === ':' || source[pos] === '.')) {
      advance();
    }
  }
}
