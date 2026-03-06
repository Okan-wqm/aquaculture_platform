/**
 * Enhanced IEC 61131-3 Structured Text language definition for Monaco Editor
 * Extended keyword set, function blocks, literals, and operators.
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
      start: /^\s*(PROGRAM|FUNCTION_BLOCK|FUNCTION|VAR|VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|IF|FOR|WHILE|REPEAT|CASE|STRUCT|TYPE)\b/i,
      end: /^\s*(END_PROGRAM|END_FUNCTION_BLOCK|END_FUNCTION|END_VAR|END_IF|END_FOR|END_WHILE|END_REPEAT|END_CASE|END_STRUCT|END_TYPE)\b/i,
    },
  },
  indentationRules: {
    increaseIndentPattern: /^\s*(IF|ELSIF|ELSE|FOR|WHILE|REPEAT|CASE|VAR|VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|PROGRAM|FUNCTION|FUNCTION_BLOCK|STRUCT|TYPE)\b/i,
    decreaseIndentPattern: /^\s*(END_IF|END_FOR|END_WHILE|END_REPEAT|END_CASE|END_VAR|END_PROGRAM|END_FUNCTION|END_FUNCTION_BLOCK|END_STRUCT|END_TYPE|ELSIF|ELSE)\b/i,
  },
};

export const stTokensProvider: languages.IMonarchLanguage = {
  ignoreCase: true,
  defaultToken: '',

  keywords: [
    'PROGRAM', 'END_PROGRAM',
    'FUNCTION', 'END_FUNCTION',
    'FUNCTION_BLOCK', 'END_FUNCTION_BLOCK',
    'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_GLOBAL',
    'VAR_TEMP', 'VAR_EXTERNAL', 'END_VAR',
    'CONSTANT', 'RETAIN',
    'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF',
    'CASE', 'OF', 'END_CASE',
    'FOR', 'TO', 'BY', 'DO', 'END_FOR',
    'WHILE', 'END_WHILE',
    'REPEAT', 'UNTIL', 'END_REPEAT',
    'RETURN', 'EXIT', 'CONTINUE',
    'AND', 'OR', 'XOR', 'NOT', 'MOD',
    'TRUE', 'FALSE',
    'AT', 'WITH', 'ARRAY',
    'TYPE', 'END_TYPE', 'STRUCT', 'END_STRUCT',
  ],

  typeKeywords: [
    'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD',
    'SINT', 'INT', 'DINT', 'LINT',
    'USINT', 'UINT', 'UDINT', 'ULINT',
    'REAL', 'LREAL',
    'STRING', 'WSTRING',
    'TIME', 'DATE', 'TOD', 'DT',
    'TIME_OF_DAY', 'DATE_AND_TIME',
  ],

  builtinFunctions: [
    'ABS', 'SQRT', 'LN', 'LOG', 'EXP', 'SIN', 'COS', 'TAN',
    'ASIN', 'ACOS', 'ATAN', 'ATAN2',
    'MAX', 'MIN', 'LIMIT', 'SEL', 'MUX',
    'SHL', 'SHR', 'ROL', 'ROR',
    'LEN', 'LEFT', 'RIGHT', 'MID', 'CONCAT', 'INSERT', 'DELETE', 'REPLACE', 'FIND',
    'BOOL_TO_INT', 'INT_TO_REAL', 'REAL_TO_INT', 'ANY_TO_STRING',
  ],

  functionBlocks: [
    'TON', 'TOF', 'TP',
    'CTU', 'CTD', 'CTUD',
    'SR', 'RS',
    'R_TRIG', 'F_TRIG',
    'PID', 'RAMP', 'HYSTERESIS', 'MAVG',
  ],

  operators: [
    ':=', '>=', '<=', '<>', '=', '>', '<',
    '+', '-', '*', '/', '**',
  ],

  symbols: /[=><!~?:&|+\-*\/\^%]+/,

  tokenizer: {
    root: [
      // Comments
      [/\(\*/, 'comment', '@comment'],
      [/\/\/.*$/, 'comment'],

      // Time literals: T#, TIME# (supports decimals like T#1.5s)
      [/T#(\d+(\.\d+)?(ms|s|m|h|d)_?)+/, 'number.time'],
      [/TIME#(\d+(\.\d+)?(ms|s|m|h|d)_?)+/, 'number.time'],

      // Date/time literals
      [/TOD#\d{2}:\d{2}:\d{2}/, 'number.date'],
      [/TIME_OF_DAY#\d{2}:\d{2}:\d{2}/, 'number.date'],
      [/DT#\d{4}-\d{2}-\d{2}[-T]\d{2}:\d{2}:\d{2}/, 'number.date'],
      [/DATE_AND_TIME#\d{4}-\d{2}-\d{2}[-T]\d{2}:\d{2}:\d{2}/, 'number.date'],
      [/D#\d{4}-\d{2}-\d{2}/, 'number.date'],
      [/DATE#\d{4}-\d{2}-\d{2}/, 'number.date'],

      // Numbers
      [/16#[0-9A-Fa-f_]+/, 'number.hex'],
      [/8#[0-7_]+/, 'number.octal'],
      [/2#[01_]+/, 'number.binary'],
      [/\d+\.\d*([eE][\-+]?\d+)?/, 'number.float'],
      [/\d+/, 'number'],

      // Strings
      [/'[^']*'/, 'string'],
      [/"[^"]*"/, 'string'],

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
