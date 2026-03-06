/**
 * Monaco CompletionItemProvider for IEC 61131-3 Structured Text
 *
 * Provides:
 * - Keyword autocomplete (78 keywords)
 * - Type autocomplete (26 types including generic)
 * - Standard function autocomplete (34 functions)
 * - Type conversion function autocomplete (52 *_TO_* functions)
 * - Function block autocomplete (24 FBs)
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
  // New keywords
  'METHOD', 'END_METHOD', 'PROPERTY', 'END_PROPERTY',
  'INTERFACE', 'END_INTERFACE', 'IMPLEMENTS', 'EXTENDS',
  'THIS', 'SUPER', 'ABSTRACT', 'FINAL',
];

const TYPES = [
  'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD',
  'SINT', 'INT', 'DINT', 'LINT',
  'USINT', 'UINT', 'UDINT', 'ULINT',
  'REAL', 'LREAL',
  'STRING', 'WSTRING',
  'TIME', 'DATE', 'TOD', 'DT',
  // Generic types
  'ANY', 'ANY_NUM', 'ANY_REAL', 'ANY_INT', 'ANY_BIT', 'ANY_STRING',
];

// Standard functions with full signatures
export interface StdFunctionDef {
  name: string;
  signature: string;
  description: string;
}

const STANDARD_FUNCTIONS: StdFunctionDef[] = [
  // Mathematical functions
  { name: 'ABS', signature: 'ABS(x : ANY_NUM) : ANY_NUM', description: 'Absolute value' },
  { name: 'SQRT', signature: 'SQRT(x : ANY_REAL) : ANY_REAL', description: 'Square root' },
  { name: 'LN', signature: 'LN(x : ANY_REAL) : ANY_REAL', description: 'Natural logarithm' },
  { name: 'LOG', signature: 'LOG(x : ANY_REAL) : ANY_REAL', description: 'Base-10 logarithm' },
  { name: 'EXP', signature: 'EXP(x : ANY_REAL) : ANY_REAL', description: 'Exponential e^x' },
  { name: 'EXPT', signature: 'EXPT(base : ANY_REAL, exp : ANY_NUM) : ANY_REAL', description: 'Power (base^exp)' },
  { name: 'SIN', signature: 'SIN(x : ANY_REAL) : ANY_REAL', description: 'Sine (radians)' },
  { name: 'COS', signature: 'COS(x : ANY_REAL) : ANY_REAL', description: 'Cosine (radians)' },
  { name: 'TAN', signature: 'TAN(x : ANY_REAL) : ANY_REAL', description: 'Tangent (radians)' },
  { name: 'ASIN', signature: 'ASIN(x : ANY_REAL) : ANY_REAL', description: 'Arc sine' },
  { name: 'ACOS', signature: 'ACOS(x : ANY_REAL) : ANY_REAL', description: 'Arc cosine' },
  { name: 'ATAN', signature: 'ATAN(x : ANY_REAL) : ANY_REAL', description: 'Arc tangent' },
  { name: 'ATAN2', signature: 'ATAN2(y, x : ANY_REAL) : ANY_REAL', description: 'Two-argument arc tangent' },
  { name: 'TRUNC', signature: 'TRUNC(x : ANY_REAL) : ANY_INT', description: 'Truncate to integer' },
  // Selection and limit functions
  { name: 'MAX', signature: 'MAX(a, b, ... : ANY) : ANY', description: 'Maximum value' },
  { name: 'MIN', signature: 'MIN(a, b, ... : ANY) : ANY', description: 'Minimum value' },
  { name: 'LIMIT', signature: 'LIMIT(MN, IN, MX : ANY) : ANY', description: 'Clamp value between min and max' },
  { name: 'SEL', signature: 'SEL(G : BOOL, IN0, IN1 : ANY) : ANY', description: 'Binary selector (G=FALSE->IN0, G=TRUE->IN1)' },
  { name: 'MUX', signature: 'MUX(K : ANY_INT, IN0, IN1, ... : ANY) : ANY', description: 'Multiplexer - select input by index K' },
  { name: 'MOVE', signature: 'MOVE(IN : ANY) : ANY', description: 'Copy value' },
  // String functions
  { name: 'LEN', signature: 'LEN(IN : STRING) : INT', description: 'String length' },
  { name: 'LEFT', signature: 'LEFT(IN : STRING, L : INT) : STRING', description: 'Leftmost L characters' },
  { name: 'RIGHT', signature: 'RIGHT(IN : STRING, L : INT) : STRING', description: 'Rightmost L characters' },
  { name: 'MID', signature: 'MID(IN : STRING, L, P : INT) : STRING', description: 'L characters starting at position P' },
  { name: 'CONCAT', signature: 'CONCAT(IN1, IN2, ... : STRING) : STRING', description: 'Concatenate strings' },
  { name: 'INSERT', signature: 'INSERT(IN1, IN2 : STRING, P : INT) : STRING', description: 'Insert IN2 into IN1 at position P' },
  { name: 'DELETE', signature: 'DELETE(IN : STRING, L, P : INT) : STRING', description: 'Delete L characters at position P' },
  { name: 'REPLACE', signature: 'REPLACE(IN1, IN2 : STRING, L, P : INT) : STRING', description: 'Replace L chars at P with IN2' },
  { name: 'FIND', signature: 'FIND(IN1, IN2 : STRING) : INT', description: 'Find position of IN2 in IN1' },
  // Bit manipulation
  { name: 'SHL', signature: 'SHL(IN : ANY_BIT, N : ANY_INT) : ANY_BIT', description: 'Shift left by N bits' },
  { name: 'SHR', signature: 'SHR(IN : ANY_BIT, N : ANY_INT) : ANY_BIT', description: 'Shift right by N bits' },
  { name: 'ROL', signature: 'ROL(IN : ANY_BIT, N : ANY_INT) : ANY_BIT', description: 'Rotate left by N bits' },
  { name: 'ROR', signature: 'ROR(IN : ANY_BIT, N : ANY_INT) : ANY_BIT', description: 'Rotate right by N bits' },
];

// Type conversion functions (*_TO_* pattern)
const conversionPairs: [string, string][] = [
  ['BOOL', 'INT'], ['BOOL', 'DINT'], ['BOOL', 'REAL'], ['BOOL', 'STRING'], ['BOOL', 'BYTE'], ['BOOL', 'WORD'],
  ['INT', 'REAL'], ['INT', 'LREAL'], ['INT', 'DINT'], ['INT', 'LINT'], ['INT', 'STRING'], ['INT', 'BOOL'], ['INT', 'BYTE'], ['INT', 'WORD'],
  ['DINT', 'REAL'], ['DINT', 'LREAL'], ['DINT', 'INT'], ['DINT', 'LINT'], ['DINT', 'STRING'], ['DINT', 'BOOL'], ['DINT', 'WORD'], ['DINT', 'DWORD'],
  ['LINT', 'REAL'], ['LINT', 'LREAL'], ['LINT', 'INT'], ['LINT', 'DINT'], ['LINT', 'STRING'],
  ['REAL', 'INT'], ['REAL', 'DINT'], ['REAL', 'LINT'], ['REAL', 'LREAL'], ['REAL', 'STRING'], ['REAL', 'BOOL'],
  ['LREAL', 'REAL'], ['LREAL', 'INT'], ['LREAL', 'DINT'], ['LREAL', 'LINT'], ['LREAL', 'STRING'],
  ['STRING', 'INT'], ['STRING', 'DINT'], ['STRING', 'REAL'], ['STRING', 'LREAL'], ['STRING', 'BOOL'],
  ['TIME', 'DINT'], ['TIME', 'STRING'], ['TIME', 'LINT'],
  ['DINT', 'TIME'], ['LINT', 'TIME'], ['STRING', 'TIME'],
  ['BYTE', 'BOOL'], ['BYTE', 'INT'], ['BYTE', 'WORD'],
  ['WORD', 'BOOL'], ['WORD', 'INT'], ['WORD', 'DINT'], ['WORD', 'DWORD'],
  ['DWORD', 'BOOL'], ['DWORD', 'DINT'], ['DWORD', 'REAL'], ['DWORD', 'WORD'],
  ['DATE', 'STRING'], ['TOD', 'STRING'], ['DT', 'STRING'], ['DT', 'DATE'],
];

const TYPE_CONVERSION_FUNCTIONS: StdFunctionDef[] = conversionPairs.map(([from, to]) => ({
  name: `${from}_TO_${to}`,
  signature: `${from}_TO_${to}(IN : ${from}) : ${to}`,
  description: `Convert ${from} to ${to}`,
}));

// Function Block definitions with full parameter signatures
export interface FBDef {
  name: string;
  detail: string;
  signature: string;
  description: string;
}

const FUNCTION_BLOCKS: FBDef[] = [
  // Existing FBs with full signatures
  { name: 'TON', detail: 'Timer On-Delay', signature: 'IN:BOOL, PT:TIME -> Q:BOOL, ET:TIME', description: 'Delays rising edge of IN by PT. Q goes TRUE after PT elapses.' },
  { name: 'TOF', detail: 'Timer Off-Delay', signature: 'IN:BOOL, PT:TIME -> Q:BOOL, ET:TIME', description: 'Delays falling edge of IN by PT. Q stays TRUE for PT after IN goes FALSE.' },
  { name: 'TP', detail: 'Timer Pulse', signature: 'IN:BOOL, PT:TIME -> Q:BOOL, ET:TIME', description: 'Generates a pulse of duration PT on rising edge of IN.' },
  { name: 'CTU', detail: 'Counter Up', signature: 'CU:BOOL, R:BOOL, PV:INT -> Q:BOOL, CV:INT', description: 'Counts up on rising edge of CU. Q=TRUE when CV>=PV. R resets CV to 0.' },
  { name: 'CTD', detail: 'Counter Down', signature: 'CD:BOOL, LD:BOOL, PV:INT -> Q:BOOL, CV:INT', description: 'Counts down on rising edge of CD. Q=TRUE when CV<=0. LD loads PV into CV.' },
  { name: 'CTUD', detail: 'Counter Up-Down', signature: 'CU:BOOL, CD:BOOL, R:BOOL, LD:BOOL, PV:INT -> QU:BOOL, QD:BOOL, CV:INT', description: 'Bidirectional counter. QU=TRUE when CV>=PV, QD=TRUE when CV<=0.' },
  { name: 'SR', detail: 'Set-Reset Flip-Flop', signature: 'S1:BOOL, R:BOOL -> Q1:BOOL', description: 'Set-dominant bistable. Q1 = S1 OR (Q1 AND NOT R).' },
  { name: 'RS', detail: 'Reset-Set Flip-Flop', signature: 'S:BOOL, R1:BOOL -> Q1:BOOL', description: 'Reset-dominant bistable. Q1 = NOT R1 AND (S OR Q1).' },
  { name: 'R_TRIG', detail: 'Rising Edge Trigger', signature: 'CLK:BOOL -> Q:BOOL', description: 'Detects rising edge. Q is TRUE for one cycle when CLK transitions from FALSE to TRUE.' },
  { name: 'F_TRIG', detail: 'Falling Edge Trigger', signature: 'CLK:BOOL -> Q:BOOL', description: 'Detects falling edge. Q is TRUE for one cycle when CLK transitions from TRUE to FALSE.' },
  { name: 'PID', detail: 'PID Controller', signature: 'SETPOINT:REAL, PV:REAL, KP:REAL, KI:REAL, KD:REAL -> OUT:REAL', description: 'Standard PID controller with proportional, integral, and derivative terms.' },
  { name: 'HYSTERESIS', detail: 'Hysteresis Controller', signature: 'IN:REAL, HIGH:REAL, LOW:REAL -> Q:BOOL', description: 'On/off control with hysteresis band. Q=TRUE when IN>HIGH, Q=FALSE when IN<LOW.' },
  { name: 'MAVG', detail: 'Moving Average', signature: 'IN:REAL, N:INT -> OUT:REAL', description: 'Computes moving average of last N input values.' },
  // New FBs
  { name: 'RAMP', detail: 'Ramp Generator', signature: 'IN:REAL, RATE:REAL, CYCLE:TIME -> OUT:REAL', description: 'Ramps output toward IN at specified RATE per second. Limits rate of change.' },
  { name: 'BLINK', detail: 'Blink Timer', signature: 'ENABLE:BOOL, TIMELOW:TIME, TIMEHIGH:TIME -> Q:BOOL', description: 'Generates a blinking output when ENABLE is TRUE. TIMELOW/TIMEHIGH set duty cycle.' },
  { name: 'DERIVATIVE', detail: 'Derivative', signature: 'IN:REAL, CYCLE:TIME -> OUT:REAL', description: 'Computes the time derivative (dIN/dt) of the input signal.' },
  { name: 'INTEGRAL', detail: 'Integral', signature: 'IN:REAL, CYCLE:TIME, R:BOOL -> OUT:REAL', description: 'Computes the time integral of the input. R resets accumulator to 0.' },
  { name: 'PID_COMPACT', detail: 'Compact PID Controller', signature: 'SETPOINT:REAL, INPUT:REAL, MANUAL:BOOL -> OUTPUT:REAL, STATE:INT', description: 'Self-tuning PID with auto/manual mode. STATE: 0=idle, 1=tuning, 2=running.' },
  { name: 'SEMA', detail: 'Semaphore', signature: 'CLAIM:BOOL, RELEASE:BOOL -> BUSY:BOOL', description: 'Binary semaphore for resource locking. BUSY=TRUE when claimed by another caller.' },
  { name: 'LIMITALARM', detail: 'Limit Alarm', signature: 'IN:REAL, HH:REAL, H:REAL, L:REAL, LL:REAL -> QHH:BOOL, QH:BOOL, QL:BOOL, QLL:BOOL', description: 'Four-level limit alarm (High-High, High, Low, Low-Low).' },
  { name: 'SCALE', detail: 'Linear Scaling', signature: 'IN:REAL, IN_MIN:REAL, IN_MAX:REAL, OUT_MIN:REAL, OUT_MAX:REAL -> OUT:REAL', description: 'Linear scaling from input range [IN_MIN..IN_MAX] to output range [OUT_MIN..OUT_MAX].' },
  { name: 'DEADBAND', detail: 'Deadband Filter', signature: 'IN:REAL, DB:REAL, LAST:REAL -> OUT:REAL', description: 'Suppresses changes smaller than DB from LAST value.' },
  { name: 'LINEARIZE', detail: 'Linearization', signature: 'IN:REAL, X:ARRAY[..] OF REAL, Y:ARRAY[..] OF REAL -> OUT:REAL', description: 'Piecewise linear interpolation using X/Y breakpoint arrays.' },
  { name: 'TOTALIZER', detail: 'Totalizer', signature: 'IN:REAL, CYCLE:TIME, R:BOOL -> OUT:REAL', description: 'Accumulates (totalizes) the input value over time. R resets to 0.' },
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

      // Standard functions
      for (const fn of STANDARD_FUNCTIONS) {
        suggestions.push({
          label: fn.name,
          kind: 1, // Function
          insertText: fn.name + '(${1})',
          insertTextRules: 4, // InsertAsSnippet
          detail: fn.signature,
          documentation: fn.description,
          range,
          sortText: '3_' + fn.name,
        });
      }

      // Type conversion functions
      for (const fn of TYPE_CONVERSION_FUNCTIONS) {
        suggestions.push({
          label: fn.name,
          kind: 1, // Function
          insertText: fn.name + '(${1})',
          insertTextRules: 4, // InsertAsSnippet
          detail: fn.signature,
          documentation: fn.description,
          range,
          sortText: '3t_' + fn.name,
        });
      }

      // Function blocks
      for (const fb of FUNCTION_BLOCKS) {
        suggestions.push({
          label: fb.name,
          kind: 6, // Class
          insertText: fb.name,
          detail: `${fb.detail} — ${fb.signature}`,
          documentation: fb.description,
          range,
          sortText: '4_' + fb.name,
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
          sortText: '5_' + tag.name,
        });
      }

      return { suggestions };
    },
  };
}

// Re-export catalogs for use by hover and snippet providers
export { STANDARD_FUNCTIONS, TYPE_CONVERSION_FUNCTIONS, FUNCTION_BLOCKS, KEYWORDS, TYPES };
