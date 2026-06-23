/**
 * Enhanced IEC 61131-3 Structured Text language definition for Monaco Editor
 * Full IEC 61131-3 keyword coverage including METHOD, PROPERTY, INTERFACE,
 * ENUM, typed literals, and extended standard library.
 */
import type { languages } from 'monaco-editor';

export const ST_LANGUAGE_ID = 'structured-text';

export const stLanguageConfig: languages.LanguageConfiguration = {
  comments: {
    lineComment: '//',
    blockComment: ['(*', '*)'],
  },
  brackets: [
    ['(', ')'],
    ['[', ']'],
  ],
  autoClosingPairs: [
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: '(*', close: '*)' },
    { open: "'", close: "'", notIn: ['string'] },
    { open: '"', close: '"', notIn: ['string'] },
  ],
  surroundingPairs: [
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: "'", close: "'" },
    { open: '"', close: '"' },
  ],
  folding: {
    markers: {
      start: /^\s*(PROGRAM|FUNCTION_BLOCK|FUNCTION|METHOD|PROPERTY|INTERFACE|VAR|VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|IF|FOR|WHILE|REPEAT|CASE|STRUCT|TYPE)\b/i,
      end: /^\s*(END_PROGRAM|END_FUNCTION_BLOCK|END_FUNCTION|END_METHOD|END_PROPERTY|END_INTERFACE|END_VAR|END_IF|END_FOR|END_WHILE|END_REPEAT|END_CASE|END_STRUCT|END_TYPE)\b/i,
    },
  },
  indentationRules: {
    increaseIndentPattern: /^\s*(IF|ELSIF|ELSE|FOR|WHILE|REPEAT|CASE|VAR|VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|PROGRAM|FUNCTION|FUNCTION_BLOCK|METHOD|PROPERTY|INTERFACE|STRUCT|TYPE)\b/i,
    decreaseIndentPattern: /^\s*(END_IF|END_FOR|END_WHILE|END_REPEAT|END_CASE|END_VAR|END_PROGRAM|END_FUNCTION|END_FUNCTION_BLOCK|END_METHOD|END_PROPERTY|END_INTERFACE|END_STRUCT|END_TYPE|ELSIF|ELSE)\b/i,
  },
};

export const stTokensProvider: languages.IMonarchLanguage = {
  ignoreCase: true,
  defaultToken: '',

  keywords: [
    // POU types
    'PROGRAM', 'END_PROGRAM',
    'FUNCTION', 'END_FUNCTION',
    'FUNCTION_BLOCK', 'END_FUNCTION_BLOCK',
    'METHOD', 'END_METHOD',
    'PROPERTY', 'END_PROPERTY',
    'INTERFACE', 'END_INTERFACE',
    // Variable blocks
    'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_GLOBAL',
    'VAR_TEMP', 'VAR_EXTERNAL', 'END_VAR',
    // Variable qualifiers
    'CONSTANT', 'RETAIN', 'PERSISTENT', 'AT',
    // Type definitions
    'TYPE', 'END_TYPE', 'STRUCT', 'END_STRUCT', 'ENUM',
    // Control flow
    'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF',
    'CASE', 'OF', 'END_CASE',
    'FOR', 'TO', 'BY', 'DO', 'END_FOR',
    'WHILE', 'END_WHILE',
    'REPEAT', 'UNTIL', 'END_REPEAT',
    'RETURN', 'EXIT', 'CONTINUE',
    // Logical / arithmetic operators (keyword form)
    'AND', 'OR', 'XOR', 'NOT', 'MOD',
    // Boolean literals
    'TRUE', 'FALSE',
    // Misc
    'WITH', 'ARRAY',
    // OOP extensions
    'EXTENDS', 'IMPLEMENTS', 'ABSTRACT', 'FINAL', 'OVERRIDE',
    'PUBLIC', 'PRIVATE', 'PROTECTED', 'INTERNAL',
    'THIS', 'SUPER', 'NEW',
  ],

  typeKeywords: [
    // Bit types
    'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD',
    // Signed integers
    'SINT', 'INT', 'DINT', 'LINT',
    // Unsigned integers
    'USINT', 'UINT', 'UDINT', 'ULINT',
    // Floating point
    'REAL', 'LREAL',
    // String types
    'STRING', 'WSTRING',
    // Date/time types
    'TIME', 'DATE', 'TOD', 'DT',
    'TIME_OF_DAY', 'DATE_AND_TIME',
    // Generic types (for documentation / hover)
    'ANY', 'ANY_NUM', 'ANY_INT', 'ANY_REAL', 'ANY_BIT', 'ANY_STRING',
    'ANY_DATE', 'ANY_DERIVED',
  ],

  builtinFunctions: [
    // Math
    'ABS', 'SQRT', 'LN', 'LOG', 'EXP', 'EXPT',
    'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN', 'ATAN2',
    'TRUNC',
    // Selection & limit
    'MAX', 'MIN', 'LIMIT', 'SEL', 'MUX', 'MOVE',
    // Bit shift
    'SHL', 'SHR', 'ROL', 'ROR',
    // String
    'LEN', 'LEFT', 'RIGHT', 'MID', 'CONCAT', 'INSERT', 'DELETE', 'REPLACE', 'FIND',
    // Type conversions (*_TO_* pattern)
    'BOOL_TO_INT', 'BOOL_TO_DINT', 'BOOL_TO_REAL', 'BOOL_TO_STRING', 'BOOL_TO_BYTE',
    'INT_TO_REAL', 'INT_TO_DINT', 'INT_TO_LINT', 'INT_TO_STRING', 'INT_TO_BOOL',
    'DINT_TO_INT', 'DINT_TO_REAL', 'DINT_TO_LINT', 'DINT_TO_STRING', 'DINT_TO_TIME',
    'LINT_TO_INT', 'LINT_TO_DINT', 'LINT_TO_REAL', 'LINT_TO_STRING',
    'REAL_TO_INT', 'REAL_TO_DINT', 'REAL_TO_LINT', 'REAL_TO_LREAL', 'REAL_TO_STRING',
    'LREAL_TO_REAL', 'LREAL_TO_DINT', 'LREAL_TO_STRING',
    'STRING_TO_INT', 'STRING_TO_DINT', 'STRING_TO_REAL', 'STRING_TO_BOOL',
    'TIME_TO_DINT', 'TIME_TO_REAL', 'TIME_TO_STRING',
    'DINT_TO_TIME', 'REAL_TO_TIME',
    'BYTE_TO_INT', 'BYTE_TO_BOOL', 'BYTE_TO_WORD',
    'WORD_TO_INT', 'WORD_TO_DWORD', 'WORD_TO_BYTE',
    'DWORD_TO_DINT', 'DWORD_TO_REAL', 'DWORD_TO_WORD',
    'ANY_TO_STRING',
    'SINT_TO_INT', 'USINT_TO_INT', 'UINT_TO_INT', 'UDINT_TO_DINT', 'ULINT_TO_LINT',
  ],

  functionBlocks: [
    // Timers
    'TON', 'TOF', 'TP',
    // Counters
    'CTU', 'CTD', 'CTUD',
    // Bistable
    'SR', 'RS',
    // Edge detection
    'R_TRIG', 'F_TRIG',
    // Control
    'PID', 'PID_COMPACT', 'RAMP', 'HYSTERESIS', 'MAVG',
    // Extended FBs
    'BLINK', 'DERIVATIVE', 'INTEGRAL',
    'SEMA', 'LIMITALARM', 'SCALE', 'DEADBAND', 'LINEARIZE', 'TOTALIZER',
  ],

  operators: [
    ':=', '=>', '>=', '<=', '<>', '=', '>', '<',
    '+', '-', '*', '/', '**',
  ],

  symbols: /[=><!~?:&|+\-*/^%]+/,

  tokenizer: {
    root: [
      // Comments
      [/\(\*/, 'comment', '@comment'],
      [/\/\/.*$/, 'comment'],

      // Time literals: T#, TIME# (supports decimals like T#1.5s, compound T#1h30m5s100ms)
      [/TIME#(\d+(\.\d+)?(d|h|m|s|ms)_?)+/i, 'number.time'],
      [/T#(\d+(\.\d+)?(d|h|m|s|ms)_?)+/i, 'number.time'],

      // Date/time literals (long form first to avoid partial matches)
      [/DATE_AND_TIME#\d{4}-\d{2}-\d{2}[-T]\d{2}:\d{2}:\d{2}(\.\d+)?/i, 'number.date'],
      [/TIME_OF_DAY#\d{2}:\d{2}:\d{2}(\.\d+)?/i, 'number.date'],
      [/DT#\d{4}-\d{2}-\d{2}[-T]\d{2}:\d{2}:\d{2}(\.\d+)?/i, 'number.date'],
      [/TOD#\d{2}:\d{2}:\d{2}(\.\d+)?/i, 'number.date'],
      [/DATE#\d{4}-\d{2}-\d{2}/i, 'number.date'],
      [/D#\d{4}-\d{2}-\d{2}/, 'number.date'],

      // Typed numeric literals: INT#5, REAL#3.14, BOOL#1, UINT#100, etc.
      [/(SINT|INT|DINT|LINT|USINT|UINT|UDINT|ULINT|BYTE|WORD|DWORD|LWORD)#[+-]?\d+/i, 'number.typed'],
      [/(REAL|LREAL)#[+-]?\d+(\.\d+)?([eE][+-]?\d+)?/i, 'number.typed'],
      [/BOOL#[01]/i, 'number.typed'],

      // Base-prefixed numeric literals
      [/16#[0-9A-Fa-f][0-9A-Fa-f_]*/, 'number.hex'],
      [/8#[0-7][0-7_]*/, 'number.octal'],
      [/2#[01][01_]*/, 'number.binary'],

      // Standard numeric literals
      [/\d+\.\d*([eE][+-]?\d+)?/, 'number.float'],
      [/\d+[eE][+-]?\d+/, 'number.float'],
      [/\d[\d_]*/, 'number'],

      // Strings
      [/'[^']*'/, 'string'],
      [/"[^"]*"/, 'string'],

      // Direct variable addresses: %IX0.0, %QW3, %MD10
      [/%[IQM][XBWDL]?\d+(\.\d+)?/, 'variable.predefined'],

      // Identifiers
      [/[a-zA-Z_]\w*/, {
        cases: {
          '@keywords': 'keyword',
          '@typeKeywords': 'type',
          '@builtinFunctions': 'predefined',
          '@functionBlocks': 'type.identifier',
          '@default': 'identifier',
        },
      }],

      // Operators
      [/:=/, 'operator.assignment'],
      [/=>/, 'operator'],
      [/@symbols/, {
        cases: {
          '@operators': 'operator',
          '@default': '',
        },
      }],

      [/[;,.]/, 'delimiter'],
      [/[()]/, '@brackets'],
      [/\[/, '@brackets'],
      [/\]/, '@brackets'],
    ],

    comment: [
      [/\(\*/, 'comment', '@push'],
      [/\*\)/, 'comment', '@pop'],
      [/[^(*]+/, 'comment'],
      [/./, 'comment'],
    ],
  },
};
