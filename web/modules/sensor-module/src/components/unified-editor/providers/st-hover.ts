/**
 * Monaco HoverProvider for IEC 61131-3 Structured Text
 *
 * Shows documentation on hover for:
 * - All 34 standard functions (signature + description)
 * - All 24 function blocks (parameters + description)
 * - All IEC keywords (brief explanation)
 * - Data types (range, size info)
 * - Type conversion functions
 */
import type { languages, editor, Position, CancellationToken } from 'monaco-editor';
import {
  STANDARD_FUNCTIONS,
  TYPE_CONVERSION_FUNCTIONS,
  FUNCTION_BLOCKS,
} from '../StCompletionProvider';

// Keyword documentation
const KEYWORD_DOCS: Record<string, string> = {
  PROGRAM: 'Declares a program organization unit (POU). Programs are the top-level executable units.',
  END_PROGRAM: 'Closes a PROGRAM declaration.',
  FUNCTION: 'Declares a function POU. Functions have no internal state and always return a value.',
  END_FUNCTION: 'Closes a FUNCTION declaration.',
  FUNCTION_BLOCK: 'Declares a function block POU. FBs have internal state and can have multiple instances.',
  END_FUNCTION_BLOCK: 'Closes a FUNCTION_BLOCK declaration.',
  METHOD: 'Declares a method within a function block. Methods can access FB internal variables.',
  END_METHOD: 'Closes a METHOD declaration.',
  PROPERTY: 'Declares a property with GET/SET accessors within a function block.',
  END_PROPERTY: 'Closes a PROPERTY declaration.',
  INTERFACE: 'Declares an interface that function blocks can implement.',
  END_INTERFACE: 'Closes an INTERFACE declaration.',
  IMPLEMENTS: 'Specifies that a function block implements an interface.',
  EXTENDS: 'Specifies that a function block or interface extends another.',
  VAR: 'Declares local variables. Scope limited to the POU.',
  VAR_INPUT: 'Declares input parameters. Values are passed in by the caller.',
  VAR_OUTPUT: 'Declares output parameters. Values are returned to the caller.',
  VAR_IN_OUT: 'Declares in-out parameters. Pass-by-reference semantics.',
  VAR_GLOBAL: 'Declares global variables accessible across POUs.',
  VAR_TEMP: 'Declares temporary variables. Not retained between calls.',
  VAR_EXTERNAL: 'References a VAR_GLOBAL declared elsewhere.',
  END_VAR: 'Closes a variable declaration block.',
  CONSTANT: 'Qualifier: variable cannot be modified after initialization.',
  RETAIN: 'Qualifier: variable value is retained across power cycles.',
  AT: 'Direct address representation for I/O mapping (e.g., AT %IX0.0).',
  IF: 'Conditional execution. Syntax: IF condition THEN ... END_IF;',
  THEN: 'Begins the body of an IF or ELSIF clause.',
  ELSIF: 'Additional conditional branch in an IF statement.',
  ELSE: 'Default branch when no IF/ELSIF condition is TRUE.',
  END_IF: 'Closes an IF statement.',
  CASE: 'Multi-way branch. Syntax: CASE expr OF value1: ...; END_CASE;',
  OF: 'Introduces CASE branches or ARRAY element type.',
  END_CASE: 'Closes a CASE statement.',
  FOR: 'Counted loop. Syntax: FOR i := start TO end [BY step] DO ... END_FOR;',
  TO: 'Specifies the end value in a FOR loop.',
  BY: 'Specifies the step increment in a FOR loop (default: 1).',
  DO: 'Begins the body of a FOR or WHILE loop.',
  END_FOR: 'Closes a FOR loop.',
  WHILE: 'Pre-tested loop. Syntax: WHILE condition DO ... END_WHILE;',
  END_WHILE: 'Closes a WHILE loop.',
  REPEAT: 'Post-tested loop. Syntax: REPEAT ... UNTIL condition END_REPEAT;',
  UNTIL: 'Specifies the exit condition of a REPEAT loop.',
  END_REPEAT: 'Closes a REPEAT loop.',
  RETURN: 'Exits the current POU and returns to the caller.',
  EXIT: 'Exits the innermost loop (FOR, WHILE, or REPEAT).',
  CONTINUE: 'Skips to the next iteration of the innermost loop.',
  AND: 'Logical AND operator. Result is TRUE only if both operands are TRUE.',
  OR: 'Logical OR operator. Result is TRUE if either operand is TRUE.',
  XOR: 'Logical exclusive OR. Result is TRUE if exactly one operand is TRUE.',
  NOT: 'Logical negation. Inverts the boolean value.',
  MOD: 'Modulo operator. Returns remainder of integer division.',
  TRUE: 'Boolean literal representing logical true.',
  FALSE: 'Boolean literal representing logical false.',
  ARRAY: 'Declares an array type. Syntax: ARRAY[lo..hi] OF type',
  WITH: 'Used in structured initialization.',
  TYPE: 'Declares a user-defined data type (STRUCT, ENUM, alias).',
  END_TYPE: 'Closes a TYPE declaration.',
  STRUCT: 'Declares a structured data type with named fields.',
  END_STRUCT: 'Closes a STRUCT declaration.',
  THIS: 'Reference to the current function block instance.',
  SUPER: 'Reference to the parent function block (when using EXTENDS).',
  ABSTRACT: 'Qualifier: FB/method must be overridden in derived FB.',
  FINAL: 'Qualifier: FB/method cannot be overridden.',
};

// Data type documentation with range and size info
const TYPE_DOCS: Record<string, string> = {
  BOOL: '**BOOL** (1 bit)\n\nBoolean: `TRUE` or `FALSE`',
  BYTE: '**BYTE** (8 bits)\n\nUnsigned: 0 to 255 (16#00 to 16#FF)',
  WORD: '**WORD** (16 bits)\n\nBit string: 16#0000 to 16#FFFF',
  DWORD: '**DWORD** (32 bits)\n\nBit string: 16#0000_0000 to 16#FFFF_FFFF',
  LWORD: '**LWORD** (64 bits)\n\nBit string: 64-bit unsigned',
  SINT: '**SINT** (8 bits, signed)\n\nRange: -128 to 127',
  INT: '**INT** (16 bits, signed)\n\nRange: -32768 to 32767',
  DINT: '**DINT** (32 bits, signed)\n\nRange: -2,147,483,648 to 2,147,483,647',
  LINT: '**LINT** (64 bits, signed)\n\nRange: -2^63 to 2^63-1',
  USINT: '**USINT** (8 bits, unsigned)\n\nRange: 0 to 255',
  UINT: '**UINT** (16 bits, unsigned)\n\nRange: 0 to 65535',
  UDINT: '**UDINT** (32 bits, unsigned)\n\nRange: 0 to 4,294,967,295',
  ULINT: '**ULINT** (64 bits, unsigned)\n\nRange: 0 to 2^64-1',
  REAL: '**REAL** (32 bits, IEEE 754)\n\nRange: ~1.2E-38 to ~3.4E+38\n\nPrecision: ~7 decimal digits',
  LREAL: '**LREAL** (64 bits, IEEE 754)\n\nRange: ~2.2E-308 to ~1.8E+308\n\nPrecision: ~15 decimal digits',
  STRING: '**STRING** (variable length)\n\nDefault max length: 255 characters\n\nSyntax: `STRING[80]` for custom length',
  WSTRING: '**WSTRING** (wide string)\n\nUnicode string, 2 bytes per character',
  TIME: '**TIME**\n\nDuration value. Literal: `T#5s`, `T#100ms`, `T#1h30m`\n\nResolution: implementation-dependent (typically 1ms)',
  DATE: '**DATE**\n\nCalendar date. Literal: `D#2026-03-06`',
  TOD: '**TIME_OF_DAY** (TOD)\n\nTime within a day. Literal: `TOD#14:30:00`',
  DT: '**DATE_AND_TIME** (DT)\n\nCombined date and time. Literal: `DT#2026-03-06-14:30:00`',
  ANY: '**ANY** (generic)\n\nMatches any data type. Used in function signatures.',
  ANY_NUM: '**ANY_NUM** (generic numeric)\n\nMatches ANY_INT or ANY_REAL.',
  ANY_REAL: '**ANY_REAL** (generic real)\n\nMatches REAL or LREAL.',
  ANY_INT: '**ANY_INT** (generic integer)\n\nMatches SINT, INT, DINT, LINT, USINT, UINT, UDINT, ULINT.',
  ANY_BIT: '**ANY_BIT** (generic bit string)\n\nMatches BOOL, BYTE, WORD, DWORD, LWORD.',
  ANY_STRING: '**ANY_STRING** (generic string)\n\nMatches STRING or WSTRING.',
};

// Build lookup maps for fast access
const functionMap = new Map<string, { signature: string; description: string }>();
for (const fn of STANDARD_FUNCTIONS) {
  functionMap.set(fn.name.toUpperCase(), { signature: fn.signature, description: fn.description });
}
for (const fn of TYPE_CONVERSION_FUNCTIONS) {
  functionMap.set(fn.name.toUpperCase(), { signature: fn.signature, description: fn.description });
}

const fbMap = new Map<string, { detail: string; signature: string; description: string }>();
for (const fb of FUNCTION_BLOCKS) {
  fbMap.set(fb.name.toUpperCase(), { detail: fb.detail, signature: fb.signature, description: fb.description });
}

/**
 * Creates a Monaco HoverProvider for Structured Text.
 */
export function createStHoverProvider(): languages.HoverProvider {
  return {
    provideHover(
      model: editor.ITextModel,
      position: Position,
      _token: CancellationToken,
    ): languages.ProviderResult<languages.Hover> {
      const word = model.getWordAtPosition(position);
      if (!word) return null;

      const token = word.word.toUpperCase();
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      // Check standard functions and type conversions
      const fn = functionMap.get(token);
      if (fn) {
        return {
          range,
          contents: [
            { value: `**Function** \`${fn.signature}\`` },
            { value: fn.description },
          ],
        };
      }

      // Check function blocks
      const fb = fbMap.get(token);
      if (fb) {
        const [inputs, outputs] = fb.signature.split(' -> ');
        const inputLines = inputs.split(', ').map((p) => `- \`${p}\``).join('\n');
        const outputLines = outputs ? outputs.split(', ').map((p) => `- \`${p}\``).join('\n') : '';
        return {
          range,
          contents: [
            { value: `**Function Block** \`${token}\` — ${fb.detail}` },
            { value: `**Inputs:**\n${inputLines}` },
            { value: outputLines ? `**Outputs:**\n${outputLines}` : '' },
            { value: fb.description },
          ].filter((c) => c.value !== ''),
        };
      }

      // Check keywords
      const kwDoc = KEYWORD_DOCS[token];
      if (kwDoc) {
        return {
          range,
          contents: [
            { value: `**Keyword** \`${token}\`` },
            { value: kwDoc },
          ],
        };
      }

      // Check data types
      const typeDoc = TYPE_DOCS[token];
      if (typeDoc) {
        return {
          range,
          contents: [{ value: typeDoc }],
        };
      }

      return null;
    },
  };
}
