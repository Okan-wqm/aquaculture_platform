/**
 * IEC 61131-3 Structured Text Variable Parser
 *
 * Extracts variable declarations from ST code VAR blocks using the existing
 * st-parser-lite AST parser. Produces a flat list of ParsedVariable objects
 * compatible with the backend CreateVariableInput shape.
 *
 * Supported VAR block types:
 *   VAR, VAR_INPUT, VAR_OUTPUT, VAR_IN_OUT, VAR_GLOBAL
 *   VAR RETAIN, VAR CONSTANT, VAR RETAIN CONSTANT
 *
 * Usage:
 *   import { parseStVariables } from '../utils/st-variable-parser';
 *   const vars = parseStVariables(stCode);
 */

import { parseST } from '../simulation/st-parser-lite';
import type {
  ASTNode,
  VarBlockNode,
  VarBlockKind,
  VarDeclarationNode,
  TypeNode,
  Expression,
} from '../simulation/st-ast-types';

// ============================================================================
// Public Types
// ============================================================================

/**
 * Variable scope values aligned with the GraphQL VariableScope enum KEYS.
 *
 * GraphQL registerEnumType exposes TypeScript enum KEYS as valid values:
 *   LOCAL, INPUT, OUTPUT, INOUT, RETAIN, CONSTANT
 *
 * The backend DTO @Transform lowercases them after GraphQL validation,
 * so we must send UPPERCASE to pass GraphQL schema validation.
 */
export type VariableScope =
  | 'LOCAL'
  | 'INPUT'
  | 'OUTPUT'
  | 'INOUT'
  | 'RETAIN'
  | 'CONSTANT';

/**
 * A single variable extracted from ST code.
 *
 * Field names match the backend CreateVariableInput DTO so the result
 * can be sent directly (after adding programId) to the addProgramVariable
 * mutation.
 */
export interface ParsedVariable {
  /** Variable name as declared in ST code */
  varName: string;
  /** IEC 61131-3 data type (BOOL, INT, REAL, STRING, TIME, ARRAY, etc.) */
  dataType: string;
  /** Backend-compatible scope value */
  scope: VariableScope;
  /** Initial value as a string, if `:=` was present */
  initialValue?: string;
  /** Inline comment text from `//` or `(* *)` on the same line */
  description?: string;
  /** Source line number (1-based) for editor navigation */
  line?: number;
}

/**
 * Result of parsing ST code for variables.
 */
export interface ParseStVariablesResult {
  /** Successfully extracted variables */
  variables: ParsedVariable[];
  /** Parser errors (empty if code is syntactically valid) */
  errors: Array<{ message: string; line: number; col: number }>;
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Map AST VarBlockKind + block flags to backend VariableScope.
 *
 * Priority: CONSTANT flag > RETAIN flag > block kind.
 * This mirrors the IEC 61131-3 semantics where `VAR CONSTANT` means
 * the variable is a compile-time constant regardless of its block.
 */
function mapScope(
  blockType: VarBlockKind,
  isConstant: boolean,
  isRetain: boolean,
): VariableScope {
  if (isConstant) return 'CONSTANT';
  if (isRetain) return 'RETAIN';

  switch (blockType) {
    case 'VAR':
      return 'LOCAL';
    case 'VAR_INPUT':
      return 'INPUT';
    case 'VAR_OUTPUT':
      return 'OUTPUT';
    case 'VAR_IN_OUT':
      return 'INOUT';
    case 'VAR_GLOBAL':
      return 'LOCAL';
    case 'VAR_TEMP':
      return 'LOCAL';
    case 'VAR_EXTERNAL':
      return 'LOCAL';
    default:
      return 'LOCAL';
  }
}

/**
 * Serialize a TypeNode back to a human-readable type string.
 *
 * Examples:
 *   { kind: 'elementaryType', name: 'REAL' } -> 'REAL'
 *   { kind: 'arrayType', dimensions: [...], elementType: ... } -> 'ARRAY[0..9] OF REAL'
 *   { kind: 'stringType', baseType: 'STRING', maxLength: 80 } -> 'STRING[80]'
 *   { kind: 'namedType', name: 'MyStruct' } -> 'MyStruct'
 */
function typeNodeToString(t: TypeNode): string {
  switch (t.kind) {
    case 'elementaryType':
      return t.name;

    case 'namedType':
      return t.name;

    case 'stringType': {
      const base = t.baseType; // STRING or WSTRING
      if (t.maxLength !== undefined) {
        const len = expressionToString(t.maxLength as Expression);
        return `${base}[${len}]`;
      }
      return base;
    }

    case 'arrayType': {
      const dims = t.dimensions
        .map((d) => `${expressionToString(d.lower)}..${expressionToString(d.upper)}`)
        .join(', ');
      return `ARRAY[${dims}] OF ${typeNodeToString(t.elementType)}`;
    }

    case 'structType':
      return 'STRUCT';

    case 'enumType':
      return 'ENUM';

    case 'subrangeType':
      return typeNodeToString(t.baseType);

    default:
      return 'UNKNOWN';
  }
}

/**
 * Serialize an Expression AST node to a string representation.
 *
 * Handles literals and simple expressions that typically appear
 * as initial values or array bounds.
 */
function expressionToString(expr: Expression | undefined): string {
  if (!expr) return '';

  switch (expr.kind) {
    case 'integerLiteral':
      return expr.raw ?? String(expr.value);
    case 'realLiteral':
      return expr.raw ?? String(expr.value);
    case 'booleanLiteral':
      return expr.value ? 'TRUE' : 'FALSE';
    case 'stringLiteral':
      return `'${expr.value}'`;
    case 'timeLiteral':
      return expr.raw;
    case 'dateLiteral':
      return expr.raw;
    case 'hexLiteral':
      return expr.raw;
    case 'identifier':
      return expr.name;
    case 'unaryExpression':
      return `${expr.operator}${expressionToString(expr.operand)}`;
    case 'binaryExpression':
      return `${expressionToString(expr.left)} ${expr.operator} ${expressionToString(expr.right)}`;
    case 'functionCall':
      return `${expr.name}(${expr.args.map(expressionToString).join(', ')})`;
    case 'memberAccess':
      return `${expressionToString(expr.object)}.${expr.member}`;
    case 'arrayAccess':
      return `${expressionToString(expr.array)}[${expr.indices.map(expressionToString).join(', ')}]`;
    case 'parenthesized':
      return `(${expressionToString(expr.expression)})`;
    default:
      return '';
  }
}

/**
 * Extract inline comments from a source line.
 *
 * The AST parser strips comments during tokenization, so we use a
 * regex-based approach to capture them for the `description` field.
 *
 * Handles both styles:
 *   temperature : REAL := 25.0; // Water temperature in Celsius
 *   pump_on : BOOL; (* Main pump enable *)
 */
function extractInlineComment(sourceLine: string): string | undefined {
  // Single-line comment: // ...
  const slashMatch = sourceLine.match(/\/\/\s*(.*?)\s*$/);
  if (slashMatch?.[1]) {
    return slashMatch[1];
  }

  // Block comment on same line: (* ... *)
  const blockMatch = sourceLine.match(/\(\*\s*(.*?)\s*\*\)/);
  if (blockMatch?.[1]) {
    return blockMatch[1];
  }

  return undefined;
}

/**
 * Build a line-to-comment index for the source code.
 * Only indexes lines that contain a semicolon (i.e., variable declaration lines).
 */
function buildCommentIndex(source: string): Map<number, string> {
  const lines = source.split('\n');
  const index = new Map<number, string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Only bother with lines that have a semicolon (declaration lines)
    if (line.includes(';')) {
      const comment = extractInlineComment(line);
      if (comment) {
        index.set(i + 1, comment); // 1-based line numbers
      }
    }
  }

  return index;
}

/**
 * Extract VarBlockNodes from any AST node type.
 * Handles PROGRAM, FUNCTION_BLOCK, and FUNCTION POUs.
 */
function extractVarBlocks(node: ASTNode): VarBlockNode[] {
  switch (node.kind) {
    case 'program':
    case 'functionBlock':
    case 'function':
      return node.varBlocks;
    default:
      return [];
  }
}

// ============================================================================
// Main Parser Function
// ============================================================================

/**
 * Parse ST code and extract all variable declarations.
 *
 * Uses the full st-parser-lite AST parser under the hood for correctness,
 * then walks the AST to produce a flat list of ParsedVariable objects.
 *
 * @param code - IEC 61131-3 Structured Text source code
 * @returns ParseStVariablesResult with variables and any parse errors
 *
 * @example
 * ```typescript
 * const result = parseStVariables(`
 *   PROGRAM Main
 *   VAR
 *     temperature : REAL := 25.0; // Water temperature
 *     pump_on : BOOL := FALSE;
 *   END_VAR
 *   VAR_INPUT
 *     setpoint : REAL;
 *   END_VAR
 *   END_PROGRAM
 * `);
 *
 * // result.variables = [
 * //   { varName: 'temperature', dataType: 'REAL', scope: 'LOCAL',
 * //     initialValue: '25.0', description: 'Water temperature', line: 4 },
 * //   { varName: 'pump_on', dataType: 'BOOL', scope: 'LOCAL',
 * //     initialValue: 'FALSE', line: 5 },
 * //   { varName: 'setpoint', dataType: 'REAL', scope: 'INPUT', line: 8 },
 * // ]
 * ```
 */
export function parseStVariables(code: string): ParseStVariablesResult {
  if (!code || code.trim().length === 0) {
    return { variables: [], errors: [] };
  }

  const { ast, errors } = parseST(code);

  // Build comment index for description extraction
  const commentIndex = buildCommentIndex(code);

  const variables: ParsedVariable[] = [];

  for (const node of ast) {
    const varBlocks = extractVarBlocks(node);

    for (const block of varBlocks) {
      const scope = mapScope(block.blockType, block.constant, block.retain);

      for (const decl of block.declarations) {
        const dataType = typeNodeToString(decl.type);
        const initialValue = decl.initialValue
          ? expressionToString(decl.initialValue)
          : undefined;

        // Source location line (1-based, from AST)
        const line = decl.location?.startLine;

        // Look up inline comment from the source
        const description = line ? commentIndex.get(line) : undefined;

        // A single declaration can declare multiple variables:
        //   a, b, c : INT := 0;
        for (const name of decl.names) {
          variables.push({
            varName: name,
            dataType,
            scope,
            ...(initialValue !== undefined && initialValue !== '' && { initialValue }),
            ...(description !== undefined && { description }),
            ...(line !== undefined && { line }),
          });
        }
      }
    }
  }

  return {
    variables,
    errors: errors.map((e) => ({ message: e.message, line: e.line, col: e.col })),
  };
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Quick check: does the ST code contain any parseable variables?
 *
 * Useful for enabling/disabling "Sync Variables" buttons in the UI
 * without running the full extraction.
 */
export function hasStVariables(code: string): boolean {
  if (!code) return false;
  // Quick regex check before invoking the parser
  return /\bVAR(?:_INPUT|_OUTPUT|_IN_OUT|_GLOBAL)?\b/i.test(code);
}

/**
 * Compute a diff between parsed variables and existing backend variables.
 *
 * Returns variables that are new (not yet in backend) and variables that
 * exist in the backend but are no longer in the ST code (removable).
 *
 * Match key is `varName` (case-insensitive).
 *
 * @param parsed - Variables extracted from ST code
 * @param existing - Variables currently stored in the backend
 */
export function diffVariables(
  parsed: ParsedVariable[],
  existing: Array<{ varName: string; id?: string; [key: string]: unknown }>,
): {
  toAdd: ParsedVariable[];
  toRemove: Array<{ varName: string; id?: string }>;
  unchanged: ParsedVariable[];
} {
  const existingMap = new Map<string, (typeof existing)[number]>();
  for (const v of existing) {
    existingMap.set(v.varName.toLowerCase(), v);
  }

  const parsedMap = new Map<string, ParsedVariable>();
  for (const v of parsed) {
    parsedMap.set(v.varName.toLowerCase(), v);
  }

  const toAdd: ParsedVariable[] = [];
  const unchanged: ParsedVariable[] = [];

  for (const v of parsed) {
    if (existingMap.has(v.varName.toLowerCase())) {
      unchanged.push(v);
    } else {
      toAdd.push(v);
    }
  }

  const toRemove: Array<{ varName: string; id?: string }> = [];
  for (const v of existing) {
    if (!parsedMap.has(v.varName.toLowerCase())) {
      toRemove.push({ varName: v.varName, id: v.id });
    }
  }

  return { toAdd, toRemove, unchanged };
}
