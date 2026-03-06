/**
 * IEC 61131-3 Structured Text Token Definitions
 *
 * Comprehensive token set covering:
 * - All IEC 61131-3 Edition 3 keywords
 * - Data types (elementary + generic)
 * - Operators (arithmetic, comparison, logical, bitwise)
 * - Literals (numeric, string, time, date, boolean)
 * - Punctuation and delimiters
 * - Special tokens (identifier, whitespace, comment, EOF, error)
 */

// ────────────────────────────────────────────────────────────────────────────
// Token Type Enum
// ────────────────────────────────────────────────────────────────────────────

export enum TokenType {
  // ── POU Keywords ──────────────────────────────────────────────────────
  PROGRAM = 'PROGRAM',
  END_PROGRAM = 'END_PROGRAM',
  FUNCTION = 'FUNCTION',
  END_FUNCTION = 'END_FUNCTION',
  FUNCTION_BLOCK = 'FUNCTION_BLOCK',
  END_FUNCTION_BLOCK = 'END_FUNCTION_BLOCK',
  METHOD = 'METHOD',
  END_METHOD = 'END_METHOD',
  PROPERTY = 'PROPERTY',
  END_PROPERTY = 'END_PROPERTY',
  INTERFACE = 'INTERFACE',
  END_INTERFACE = 'END_INTERFACE',

  // ── Variable Declaration Keywords ─────────────────────────────────────
  VAR = 'VAR',
  VAR_INPUT = 'VAR_INPUT',
  VAR_OUTPUT = 'VAR_OUTPUT',
  VAR_IN_OUT = 'VAR_IN_OUT',
  VAR_GLOBAL = 'VAR_GLOBAL',
  VAR_TEMP = 'VAR_TEMP',
  VAR_EXTERNAL = 'VAR_EXTERNAL',
  END_VAR = 'END_VAR',
  CONSTANT = 'CONSTANT',
  RETAIN = 'RETAIN',
  PERSISTENT = 'PERSISTENT',
  AT = 'AT',

  // ── Control Flow Keywords ─────────────────────────────────────────────
  IF = 'IF',
  THEN = 'THEN',
  ELSIF = 'ELSIF',
  ELSE = 'ELSE',
  END_IF = 'END_IF',
  CASE = 'CASE',
  OF = 'OF',
  END_CASE = 'END_CASE',
  FOR = 'FOR',
  TO = 'TO',
  BY = 'BY',
  DO = 'DO',
  END_FOR = 'END_FOR',
  WHILE = 'WHILE',
  END_WHILE = 'END_WHILE',
  REPEAT = 'REPEAT',
  UNTIL = 'UNTIL',
  END_REPEAT = 'END_REPEAT',
  RETURN = 'RETURN',
  EXIT = 'EXIT',

  // ── Type Declaration Keywords ─────────────────────────────────────────
  TYPE = 'TYPE',
  END_TYPE = 'END_TYPE',
  STRUCT = 'STRUCT',
  END_STRUCT = 'END_STRUCT',
  ENUM = 'ENUM',
  ARRAY = 'ARRAY',

  // ── Elementary Data Types ─────────────────────────────────────────────
  BOOL = 'BOOL',
  BYTE = 'BYTE',
  WORD = 'WORD',
  DWORD = 'DWORD',
  LWORD = 'LWORD',
  SINT = 'SINT',
  INT = 'INT',
  DINT = 'DINT',
  LINT = 'LINT',
  USINT = 'USINT',
  UINT = 'UINT',
  UDINT = 'UDINT',
  ULINT = 'ULINT',
  REAL = 'REAL',
  LREAL = 'LREAL',
  STRING = 'STRING',
  WSTRING = 'WSTRING',
  TIME = 'TIME',
  DATE = 'DATE',
  TIME_OF_DAY = 'TIME_OF_DAY',
  TOD = 'TOD',
  DATE_AND_TIME = 'DATE_AND_TIME',
  DT = 'DT',

  // ── Logical / Bitwise Operator Keywords ───────────────────────────────
  AND = 'AND',
  OR = 'OR',
  XOR = 'XOR',
  NOT = 'NOT',
  MOD = 'MOD',
  SHL = 'SHL',
  SHR = 'SHR',
  ROL = 'ROL',
  ROR = 'ROR',

  // ── Boolean Literal Keywords ──────────────────────────────────────────
  TRUE = 'TRUE',
  FALSE = 'FALSE',

  // ── Arithmetic / Comparison Operators (symbols) ───────────────────────
  PLUS = 'PLUS',             // +
  MINUS = 'MINUS',           // -
  STAR = 'STAR',             // *
  SLASH = 'SLASH',           // /
  POWER = 'POWER',           // **
  ASSIGN = 'ASSIGN',         // :=
  OUTPUT_ASSIGN = 'OUTPUT_ASSIGN', // =>
  EQ = 'EQ',                 // =
  NEQ = 'NEQ',               // <>
  LT = 'LT',                 // <
  GT = 'GT',                 // >
  LE = 'LE',                 // <=
  GE = 'GE',                 // >=

  // ── Punctuation ───────────────────────────────────────────────────────
  LPAREN = 'LPAREN',         // (
  RPAREN = 'RPAREN',         // )
  LBRACKET = 'LBRACKET',     // [
  RBRACKET = 'RBRACKET',     // ]
  COMMA = 'COMMA',           // ,
  SEMICOLON = 'SEMICOLON',   // ;
  COLON = 'COLON',           // :
  DOT = 'DOT',               // .
  DOTDOT = 'DOTDOT',         // ..
  HASH = 'HASH',             // #
  ARROW = 'ARROW',           // ^

  // ── Literal Tokens ────────────────────────────────────────────────────
  INTEGER_LITERAL = 'INTEGER_LITERAL',
  REAL_LITERAL = 'REAL_LITERAL',
  STRING_LITERAL = 'STRING_LITERAL',
  TIME_LITERAL = 'TIME_LITERAL',
  DATE_LITERAL = 'DATE_LITERAL',
  BOOLEAN_LITERAL = 'BOOLEAN_LITERAL',
  HEX_LITERAL = 'HEX_LITERAL',
  OCTAL_LITERAL = 'OCTAL_LITERAL',
  BINARY_LITERAL = 'BINARY_LITERAL',

  // ── Special Tokens ────────────────────────────────────────────────────
  IDENTIFIER = 'IDENTIFIER',
  WHITESPACE = 'WHITESPACE',
  COMMENT = 'COMMENT',
  NEWLINE = 'NEWLINE',
  EOF = 'EOF',
  ERROR = 'ERROR',
}

// ────────────────────────────────────────────────────────────────────────────
// Token Interface
// ────────────────────────────────────────────────────────────────────────────

export interface Token {
  /** Token classification */
  type: TokenType;
  /** Raw source text of the token */
  value: string;
  /** 1-based line number */
  line: number;
  /** 1-based column number */
  col: number;
  /** 0-based byte offset in source */
  offset: number;
  /** Length in characters */
  length: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Lexer Result & Error Types
// ────────────────────────────────────────────────────────────────────────────

export interface LexerError {
  message: string;
  line: number;
  col: number;
  offset: number;
  length: number;
}

export interface LexerResult {
  tokens: Token[];
  errors: LexerError[];
}
