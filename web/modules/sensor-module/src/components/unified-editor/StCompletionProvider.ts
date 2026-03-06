/**
 * Monaco CompletionItemProvider for IEC 61131-3 Structured Text
 *
 * Provides:
 * - Keyword autocomplete
 * - Type autocomplete
 * - Function block autocomplete
 * - Snippet completions (IF, FOR, WHILE, VAR, PROGRAM, etc.)
 * - Device I/O tag suggestions (injected via setTags)
 */
import type { languages, editor, Position, CancellationToken } from 'monaco-editor';

export interface StTag {
  name: string;
  ioType: string;        // AI, AO, DI, DO
  dataType: string;       // FLOAT32, BOOL, INT, etc.
  description?: string;
}

// Map hardware data types to IEC 61131-3 types
const dataTypeMap: Record<string, string> = {
  FLOAT32: 'REAL',
  FLOAT64: 'LREAL',
  INT16: 'INT',
  INT32: 'DINT',
  INT64: 'LINT',
  UINT16: 'UINT',
  UINT32: 'UDINT',
  BOOL: 'BOOL',
  BYTE: 'BYTE',
  WORD: 'WORD',
  DWORD: 'DWORD',
};

function mapDataType(hw: string): string {
  return dataTypeMap[hw.toUpperCase()] || hw;
}

// Singleton tag list - updated externally
let currentTags: StTag[] = [];

export function setTags(tags: StTag[]) {
  currentTags = tags;
}

export function getTags(): StTag[] {
  return currentTags;
}

// Keyword completions
const KEYWORDS = [
  'PROGRAM', 'END_PROGRAM', 'FUNCTION', 'END_FUNCTION',
  'FUNCTION_BLOCK', 'END_FUNCTION_BLOCK',
  'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT',
  'VAR_GLOBAL', 'VAR_TEMP', 'VAR_EXTERNAL', 'END_VAR',
  'CONSTANT', 'RETAIN', 'AT',
  'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF',
  'CASE', 'OF', 'END_CASE',
  'FOR', 'TO', 'BY', 'DO', 'END_FOR',
  'WHILE', 'END_WHILE', 'REPEAT', 'UNTIL', 'END_REPEAT',
  'RETURN', 'EXIT', 'CONTINUE',
  'AND', 'OR', 'XOR', 'NOT', 'MOD',
  'TRUE', 'FALSE',
  'ARRAY', 'WITH',
  'TYPE', 'END_TYPE', 'STRUCT', 'END_STRUCT',
];

const TYPES = [
  'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD',
  'SINT', 'INT', 'DINT', 'LINT',
  'USINT', 'UINT', 'UDINT', 'ULINT',
  'REAL', 'LREAL',
  'STRING', 'WSTRING',
  'TIME', 'DATE', 'TOD', 'DT',
];

const FUNCTION_BLOCKS = [
  { name: 'TON', detail: 'Timer On-Delay' },
  { name: 'TOF', detail: 'Timer Off-Delay' },
  { name: 'TP', detail: 'Timer Pulse' },
  { name: 'CTU', detail: 'Counter Up' },
  { name: 'CTD', detail: 'Counter Down' },
  { name: 'CTUD', detail: 'Counter Up-Down' },
  { name: 'PID', detail: 'PID Controller' },
  { name: 'R_TRIG', detail: 'Rising Edge Trigger' },
  { name: 'F_TRIG', detail: 'Falling Edge Trigger' },
  { name: 'SR', detail: 'Set-Reset Flip-Flop' },
  { name: 'RS', detail: 'Reset-Set Flip-Flop' },
  { name: 'MAVG', detail: 'Moving Average' },
  { name: 'HYSTERESIS', detail: 'Hysteresis Controller' },
];

interface SnippetDef {
  label: string;
  insertText: string;
  detail: string;
}

const SNIPPETS: SnippetDef[] = [
  {
    label: 'PROGRAM',
    insertText: 'PROGRAM ${1:ProgramName}\nVAR\n\t${2:// variables}\nEND_VAR\n\n${3:// logic}\n\nEND_PROGRAM',
    detail: 'Program declaration',
  },
  {
    label: 'FUNCTION_BLOCK',
    insertText: 'FUNCTION_BLOCK ${1:FBName}\nVAR_INPUT\n\t${2}\nEND_VAR\nVAR_OUTPUT\n\t${3}\nEND_VAR\nVAR\n\t${4}\nEND_VAR\n\n${5}\n\nEND_FUNCTION_BLOCK',
    detail: 'Function Block declaration',
  },
  {
    label: 'IF..THEN..END_IF',
    insertText: 'IF ${1:condition} THEN\n\t${2}\nEND_IF;',
    detail: 'If-Then block',
  },
  {
    label: 'IF..THEN..ELSE..END_IF',
    insertText: 'IF ${1:condition} THEN\n\t${2}\nELSE\n\t${3}\nEND_IF;',
    detail: 'If-Then-Else block',
  },
  {
    label: 'FOR..DO..END_FOR',
    insertText: 'FOR ${1:i} := ${2:0} TO ${3:10} DO\n\t${4}\nEND_FOR;',
    detail: 'For loop',
  },
  {
    label: 'WHILE..DO..END_WHILE',
    insertText: 'WHILE ${1:condition} DO\n\t${2}\nEND_WHILE;',
    detail: 'While loop',
  },
  {
    label: 'REPEAT..UNTIL..END_REPEAT',
    insertText: 'REPEAT\n\t${1}\nUNTIL ${2:condition}\nEND_REPEAT;',
    detail: 'Repeat-Until loop',
  },
  {
    label: 'CASE..OF..END_CASE',
    insertText: 'CASE ${1:variable} OF\n\t${2:1}: ${3};\n\t${4:2}: ${5};\nELSE\n\t${6};\nEND_CASE;',
    detail: 'Case statement',
  },
  {
    label: 'VAR..END_VAR',
    insertText: 'VAR\n\t${1:varName} : ${2:INT};\nEND_VAR',
    detail: 'Variable declaration block',
  },
  {
    label: 'VAR_INPUT..END_VAR',
    insertText: 'VAR_INPUT\n\t${1:inputName} : ${2:REAL};\nEND_VAR',
    detail: 'Input variable declaration',
  },
  {
    label: 'TON timer',
    insertText: '${1:timer} : TON;\n${1:timer}(IN := ${2:startCond}, PT := T#${3:1000}ms);\nIF ${1:timer}.Q THEN\n\t${4}\nEND_IF;',
    detail: 'TON timer with output check',
  },
  {
    label: 'PID controller',
    insertText: '${1:pid} : PID;\n${1:pid}(\n\tSETPOINT := ${2:target},\n\tPROCESS_VALUE := ${3:sensor},\n\tKP := ${4:1.0},\n\tKI := ${5:0.1},\n\tKD := ${6:0.01}\n);',
    detail: 'PID controller instance',
  },
];

export function createStCompletionProvider(): languages.CompletionItemProvider {
  return {
    triggerCharacters: ['.', ':'],

    provideCompletionItems(
      model: editor.ITextModel,
      position: Position,
      _context: languages.CompletionContext,
      _token: CancellationToken,
    ): languages.ProviderResult<languages.CompletionList> {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const suggestions: languages.CompletionItem[] = [];

      // Snippets (highest priority)
      for (const s of SNIPPETS) {
        suggestions.push({
          label: s.label,
          kind: 27, // Snippet
          insertText: s.insertText,
          insertTextRules: 4, // InsertAsSnippet
          detail: s.detail,
          range,
          sortText: '0_' + s.label,
        });
      }

      // Keywords
      for (const kw of KEYWORDS) {
        suggestions.push({
          label: kw,
          kind: 14, // Keyword
          insertText: kw,
          range,
          sortText: '1_' + kw,
        });
      }

      // Types
      for (const t of TYPES) {
        suggestions.push({
          label: t,
          kind: 25, // TypeParameter
          insertText: t,
          detail: 'Data type',
          range,
          sortText: '2_' + t,
        });
      }

      // Function blocks
      for (const fb of FUNCTION_BLOCKS) {
        suggestions.push({
          label: fb.name,
          kind: 6, // Class
          insertText: fb.name,
          detail: fb.detail,
          range,
          sortText: '3_' + fb.name,
        });
      }

      // Device I/O tags
      for (const tag of currentTags) {
        const iecType = mapDataType(tag.dataType);
        suggestions.push({
          label: tag.name,
          kind: 5, // Field
          insertText: tag.name,
          detail: `${tag.ioType} : ${iecType}${tag.description ? ' - ' + tag.description : ''}`,
          range,
          sortText: '4_' + tag.name,
        });
      }

      return { suggestions };
    },
  };
}
