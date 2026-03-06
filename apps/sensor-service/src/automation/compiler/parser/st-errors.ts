/**
 * IEC 61131-3 Structured Text Parser Error Types
 *
 * Error codes:
 * - STP001-STP099: Parser errors
 * - STL001-STL099: Lexer errors (defined in lexer module)
 *
 * Error recovery strategies:
 * - SYNC_SEMICOLON: skip to next semicolon
 * - SYNC_END: skip to next END_* keyword
 * - SYNC_KEYWORD: skip to next statement keyword (IF, FOR, WHILE, etc.)
 * - SYNC_VAR_END: skip to END_VAR
 * - SYNC_POU_END: skip to END_PROGRAM / END_FUNCTION / END_FUNCTION_BLOCK
 */

import type { ParseError } from './st-ast';

// ────────────────────────────────────────────────────────────────────────────
// Error Codes
// ────────────────────────────────────────────────────────────────────────────

export const ParserErrorCode = {
  // ── Unexpected Token (STP001-STP009) ──────────────────────────────────
  UNEXPECTED_TOKEN: 'STP001',
  EXPECTED_IDENTIFIER: 'STP002',
  EXPECTED_SEMICOLON: 'STP003',
  EXPECTED_COLON: 'STP004',
  EXPECTED_ASSIGN: 'STP005',
  EXPECTED_EXPRESSION: 'STP006',
  EXPECTED_TYPE: 'STP007',
  EXPECTED_RPAREN: 'STP008',
  EXPECTED_RBRACKET: 'STP009',

  // ── Missing Keyword (STP010-STP029) ───────────────────────────────────
  MISSING_THEN: 'STP010',
  MISSING_END_IF: 'STP011',
  MISSING_DO: 'STP012',
  MISSING_END_FOR: 'STP013',
  MISSING_END_WHILE: 'STP014',
  MISSING_UNTIL: 'STP015',
  MISSING_END_REPEAT: 'STP016',
  MISSING_OF: 'STP017',
  MISSING_END_CASE: 'STP018',
  MISSING_END_VAR: 'STP019',
  MISSING_END_PROGRAM: 'STP020',
  MISSING_END_FUNCTION: 'STP021',
  MISSING_END_FUNCTION_BLOCK: 'STP022',
  MISSING_END_METHOD: 'STP023',
  MISSING_END_PROPERTY: 'STP024',
  MISSING_END_INTERFACE: 'STP025',
  MISSING_END_TYPE: 'STP026',
  MISSING_END_STRUCT: 'STP027',
  MISSING_TO: 'STP028',

  // ── Declaration Errors (STP030-STP049) ────────────────────────────────
  INVALID_VAR_BLOCK: 'STP030',
  DUPLICATE_VARIABLE: 'STP031',
  INVALID_INITIAL_VALUE: 'STP032',
  INVALID_ARRAY_DIMENSION: 'STP033',
  INVALID_TYPE_DECLARATION: 'STP034',
  INVALID_ENUM_MEMBER: 'STP035',
  INVALID_STRUCT_MEMBER: 'STP036',
  MISSING_RETURN_TYPE: 'STP037',

  // ── Expression Errors (STP050-STP069) ─────────────────────────────────
  INVALID_EXPRESSION: 'STP050',
  INVALID_OPERATOR: 'STP051',
  INVALID_LITERAL: 'STP052',
  UNCLOSED_PARENTHESIS: 'STP053',
  INVALID_FUNCTION_CALL: 'STP054',
  INVALID_ARRAY_ACCESS: 'STP055',
  INVALID_MEMBER_ACCESS: 'STP056',
  INVALID_CASE_LABEL: 'STP057',

  // ── Security / Limits (STP080-STP089) ─────────────────────────────────
  MAX_NESTING_EXCEEDED: 'STP080',
  MAX_ERRORS_EXCEEDED: 'STP081',
  TOKEN_LIMIT_EXCEEDED: 'STP082',
  PARSE_TIMEOUT: 'STP083',

  // ── General (STP090-STP099) ───────────────────────────────────────────
  EMPTY_PROGRAM: 'STP090',
  UNEXPECTED_EOF: 'STP091',
  INTERNAL_ERROR: 'STP099',
} as const;

export type ParserErrorCodeType = (typeof ParserErrorCode)[keyof typeof ParserErrorCode];

// ────────────────────────────────────────────────────────────────────────────
// Recovery Strategy
// ────────────────────────────────────────────────────────────────────────────

export enum RecoveryStrategy {
  SYNC_SEMICOLON = 'SYNC_SEMICOLON',
  SYNC_END = 'SYNC_END',
  SYNC_KEYWORD = 'SYNC_KEYWORD',
  SYNC_VAR_END = 'SYNC_VAR_END',
  SYNC_POU_END = 'SYNC_POU_END',
  NONE = 'NONE',
}

// ────────────────────────────────────────────────────────────────────────────
// Error Factory
// ────────────────────────────────────────────────────────────────────────────

export function createParseError(
  code: string,
  message: string,
  line: number,
  col: number,
  endLine?: number,
  endCol?: number,
  hint?: string,
  severity: 'error' | 'warning' = 'error',
): ParseError {
  return {
    code,
    message,
    line,
    col,
    endLine: endLine ?? line,
    endCol: endCol ?? col + 1,
    severity,
    hint,
  };
}
