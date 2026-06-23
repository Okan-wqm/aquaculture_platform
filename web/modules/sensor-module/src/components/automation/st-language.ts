/**
 * IEC 61131-3 Structured Text language definition for Monaco Editor
 */
// monaco-editor is a direct dependency and ships its own type declarations,
// so this type-only import resolves without a suppression.
import type { languages } from 'monaco-editor';

export const ST_LANGUAGE_ID = 'iec61131-st';

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
    { open: "'", close: "'" },
  ],
  surroundingPairs: [
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: "'", close: "'" },
  ],
  folding: {
    markers: {
      start: /^\s*(PROGRAM|FUNCTION_BLOCK|FUNCTION|VAR|IF|FOR|WHILE|REPEAT|CASE)\b/i,
      end: /^\s*(END_PROGRAM|END_FUNCTION_BLOCK|END_FUNCTION|END_VAR|END_IF|END_FOR|END_WHILE|END_REPEAT|END_CASE)\b/i,
    },
  },
};

export const stTokensProvider: languages.IMonarchLanguage = {
  ignoreCase: true,
  defaultToken: '',

  keywords: [
    'PROGRAM', 'END_PROGRAM', 'FUNCTION', 'END_FUNCTION',
    'FUNCTION_BLOCK', 'END_FUNCTION_BLOCK',
    'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_GLOBAL',
    'VAR_TEMP', 'VAR_EXTERNAL', 'END_VAR', 'CONSTANT', 'RETAIN',
    'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF',
    'CASE', 'OF', 'END_CASE',
    'FOR', 'TO', 'BY', 'DO', 'END_FOR',
    'WHILE', 'END_WHILE',
    'REPEAT', 'UNTIL', 'END_REPEAT',
    'RETURN', 'EXIT', 'CONTINUE',
    'AND', 'OR', 'XOR', 'NOT', 'MOD',
    'TRUE', 'FALSE',
    'AT', 'WITH', 'ARRAY',
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

  functionBlocks: [
    'TON', 'TOF', 'TP',
    'CTU', 'CTD', 'CTUD',
    'RS', 'SR',
    'R_TRIG', 'F_TRIG',
    'PID', 'HYSTERESIS', 'MAVG',
  ],

  operators: [
    ':=', '>=', '<=', '<>', '=', '>', '<',
    '+', '-', '*', '/', '**',
  ],

  symbols: /[=><!~?:&|+\-*/^%]+/,

  tokenizer: {
    root: [
      [/\(\*/, 'comment', '@comment'],
      [/\/\/.*$/, 'comment'],

      // Time literals
      [/T#[\d_]+(ms|s|m|h|d)/, 'number.time'],
      [/TIME#[\d_]+(ms|s|m|h|d)/, 'number.time'],

      // Numbers
      [/16#[0-9A-Fa-f_]+/, 'number.hex'],
      [/8#[0-7_]+/, 'number.octal'],
      [/2#[01_]+/, 'number.binary'],
      [/\d+\.\d*([eE][-+]?\d+)?/, 'number.float'],
      [/\d+/, 'number'],

      // Strings
      [/'[^']*'/, 'string'],

      // Identifiers
      [/[a-zA-Z_]\w*/, {
        cases: {
          '@keywords': 'keyword',
          '@typeKeywords': 'type',
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
      [/[^(*]+/, 'comment'],
      [/\*\)/, 'comment', '@pop'],
      [/./, 'comment'],
    ],
  },
};

export const stCompletionProvider = {
  provideCompletionItems: () => {
    const suggestions = [
      { label: 'PROGRAM', kind: 14, insertText: 'PROGRAM ${1:ProgramName}\nVAR\n\t${2}\nEND_VAR\n\n${3}\n\nEND_PROGRAM', insertTextRules: 4, detail: 'Program declaration' },
      { label: 'FUNCTION_BLOCK', kind: 14, insertText: 'FUNCTION_BLOCK ${1:FBName}\nVAR_INPUT\n\t${2}\nEND_VAR\nVAR_OUTPUT\n\t${3}\nEND_VAR\nVAR\n\t${4}\nEND_VAR\n\n${5}\n\nEND_FUNCTION_BLOCK', insertTextRules: 4, detail: 'Function Block declaration' },
      { label: 'VAR', kind: 14, insertText: 'VAR\n\t${1}\nEND_VAR', insertTextRules: 4 },
      { label: 'VAR_INPUT', kind: 14, insertText: 'VAR_INPUT\n\t${1}\nEND_VAR', insertTextRules: 4 },
      { label: 'VAR_OUTPUT', kind: 14, insertText: 'VAR_OUTPUT\n\t${1}\nEND_VAR', insertTextRules: 4 },
      { label: 'IF', kind: 14, insertText: 'IF ${1:condition} THEN\n\t${2}\nEND_IF;', insertTextRules: 4 },
      { label: 'IF-ELSE', kind: 14, insertText: 'IF ${1:condition} THEN\n\t${2}\nELSE\n\t${3}\nEND_IF;', insertTextRules: 4 },
      { label: 'FOR', kind: 14, insertText: 'FOR ${1:i} := ${2:0} TO ${3:10} DO\n\t${4}\nEND_FOR;', insertTextRules: 4 },
      { label: 'WHILE', kind: 14, insertText: 'WHILE ${1:condition} DO\n\t${2}\nEND_WHILE;', insertTextRules: 4 },
      { label: 'CASE', kind: 14, insertText: 'CASE ${1:variable} OF\n\t${2:1}: ${3};\n\t${4:2}: ${5};\nELSE\n\t${6};\nEND_CASE;', insertTextRules: 4 },
      { label: 'TON', kind: 6, insertText: '${1:timerName} : TON;\n${1:timerName}(IN := ${2:startCondition}, PT := T#${3:1000}ms);', insertTextRules: 4, detail: 'Timer On-Delay' },
      { label: 'TOF', kind: 6, insertText: '${1:timerName} : TOF;\n${1:timerName}(IN := ${2:startCondition}, PT := T#${3:1000}ms);', insertTextRules: 4, detail: 'Timer Off-Delay' },
      { label: 'CTU', kind: 6, insertText: '${1:counterName} : CTU;\n${1:counterName}(CU := ${2:countUp}, RESET := ${3:resetCond}, PV := ${4:100});', insertTextRules: 4, detail: 'Counter Up' },
      { label: 'PID', kind: 6, insertText: '${1:pidName} : PID;\n${1:pidName}(SETPOINT := ${2:target}, PROCESS_VALUE := ${3:sensor}, KP := ${4:1.0}, KI := ${5:0.1}, KD := ${6:0.01});', insertTextRules: 4, detail: 'PID Controller' },
    ];
    return { suggestions };
  },
};