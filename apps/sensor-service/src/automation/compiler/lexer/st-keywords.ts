/**
 * IEC 61131-3 Structured Text Keyword Dictionary
 *
 * Maps uppercase keyword strings to their TokenType.
 * Lookup is case-insensitive: callers must uppercase before lookup.
 */

import { TokenType } from './st-tokens';

// ────────────────────────────────────────────────────────────────────────────
// Keyword → TokenType mapping
// ────────────────────────────────────────────────────────────────────────────

const KEYWORD_MAP: ReadonlyMap<string, TokenType> = new Map<string, TokenType>([
  // POU
  ['PROGRAM', TokenType.PROGRAM],
  ['END_PROGRAM', TokenType.END_PROGRAM],
  ['FUNCTION', TokenType.FUNCTION],
  ['END_FUNCTION', TokenType.END_FUNCTION],
  ['FUNCTION_BLOCK', TokenType.FUNCTION_BLOCK],
  ['END_FUNCTION_BLOCK', TokenType.END_FUNCTION_BLOCK],
  ['METHOD', TokenType.METHOD],
  ['END_METHOD', TokenType.END_METHOD],
  ['PROPERTY', TokenType.PROPERTY],
  ['END_PROPERTY', TokenType.END_PROPERTY],
  ['INTERFACE', TokenType.INTERFACE],
  ['END_INTERFACE', TokenType.END_INTERFACE],

  // Variable declarations
  ['VAR', TokenType.VAR],
  ['VAR_INPUT', TokenType.VAR_INPUT],
  ['VAR_OUTPUT', TokenType.VAR_OUTPUT],
  ['VAR_IN_OUT', TokenType.VAR_IN_OUT],
  ['VAR_GLOBAL', TokenType.VAR_GLOBAL],
  ['VAR_TEMP', TokenType.VAR_TEMP],
  ['VAR_EXTERNAL', TokenType.VAR_EXTERNAL],
  ['END_VAR', TokenType.END_VAR],
  ['CONSTANT', TokenType.CONSTANT],
  ['RETAIN', TokenType.RETAIN],
  ['PERSISTENT', TokenType.PERSISTENT],
  ['AT', TokenType.AT],

  // Control flow
  ['IF', TokenType.IF],
  ['THEN', TokenType.THEN],
  ['ELSIF', TokenType.ELSIF],
  ['ELSE', TokenType.ELSE],
  ['END_IF', TokenType.END_IF],
  ['CASE', TokenType.CASE],
  ['OF', TokenType.OF],
  ['END_CASE', TokenType.END_CASE],
  ['FOR', TokenType.FOR],
  ['TO', TokenType.TO],
  ['BY', TokenType.BY],
  ['DO', TokenType.DO],
  ['END_FOR', TokenType.END_FOR],
  ['WHILE', TokenType.WHILE],
  ['END_WHILE', TokenType.END_WHILE],
  ['REPEAT', TokenType.REPEAT],
  ['UNTIL', TokenType.UNTIL],
  ['END_REPEAT', TokenType.END_REPEAT],
  ['RETURN', TokenType.RETURN],
  ['EXIT', TokenType.EXIT],

  // Type declarations
  ['TYPE', TokenType.TYPE],
  ['END_TYPE', TokenType.END_TYPE],
  ['STRUCT', TokenType.STRUCT],
  ['END_STRUCT', TokenType.END_STRUCT],
  ['ENUM', TokenType.ENUM],
  ['ARRAY', TokenType.ARRAY],

  // Elementary data types
  ['BOOL', TokenType.BOOL],
  ['BYTE', TokenType.BYTE],
  ['WORD', TokenType.WORD],
  ['DWORD', TokenType.DWORD],
  ['LWORD', TokenType.LWORD],
  ['SINT', TokenType.SINT],
  ['INT', TokenType.INT],
  ['DINT', TokenType.DINT],
  ['LINT', TokenType.LINT],
  ['USINT', TokenType.USINT],
  ['UINT', TokenType.UINT],
  ['UDINT', TokenType.UDINT],
  ['ULINT', TokenType.ULINT],
  ['REAL', TokenType.REAL],
  ['LREAL', TokenType.LREAL],
  ['STRING', TokenType.STRING],
  ['WSTRING', TokenType.WSTRING],
  ['TIME', TokenType.TIME],
  ['DATE', TokenType.DATE],
  ['TIME_OF_DAY', TokenType.TIME_OF_DAY],
  ['TOD', TokenType.TOD],
  ['DATE_AND_TIME', TokenType.DATE_AND_TIME],
  ['DT', TokenType.DT],

  // Logical / bitwise operator keywords
  ['AND', TokenType.AND],
  ['OR', TokenType.OR],
  ['XOR', TokenType.XOR],
  ['NOT', TokenType.NOT],
  ['MOD', TokenType.MOD],
  ['SHL', TokenType.SHL],
  ['SHR', TokenType.SHR],
  ['ROL', TokenType.ROL],
  ['ROR', TokenType.ROR],

  // Boolean literals
  ['TRUE', TokenType.TRUE],
  ['FALSE', TokenType.FALSE],
]);

/**
 * Look up a keyword by its uppercase form.
 * Returns the corresponding TokenType, or undefined if not a keyword.
 */
export function lookupKeyword(word: string): TokenType | undefined {
  return KEYWORD_MAP.get(word.toUpperCase());
}

/**
 * Check whether a given word (case-insensitive) is a reserved keyword.
 */
export function isKeyword(word: string): boolean {
  return KEYWORD_MAP.has(word.toUpperCase());
}

/**
 * Set of all keyword strings (uppercase) for fast membership testing.
 */
export const KEYWORDS: ReadonlySet<string> = new Set(KEYWORD_MAP.keys());
