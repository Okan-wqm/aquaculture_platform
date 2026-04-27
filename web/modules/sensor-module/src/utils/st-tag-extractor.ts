/**
 * ST Code Tag Reference Extractor
 *
 * Parses IEC 61131-3 Structured Text code to extract VAR_INPUT, VAR_OUTPUT,
 * and VAR_IN_OUT variable declarations. These I/O variables represent
 * references to physical device I/O tags that need binding to DeviceIoConfig
 * entries before the program can interact with real hardware.
 *
 * This utility uses the browser-side ST parser (st-parser-lite) to produce
 * an AST and then walks the VAR blocks to find I/O-scoped declarations.
 */

import { parseST } from '../simulation/st-parser-lite';
import type {
  ASTNode,
  VarBlockNode,
  VarBlockKind,
  VarDeclarationNode,
  TypeNode,
} from '@platform/sensor-automation-types';

// ────────────────────────────────────────────────────────────────────────────
// Public Types
// ────────────────────────────────────────────────────────────────────────────

/** Direction of an I/O variable relative to the PLC program */
export type IoDirection = 'input' | 'output' | 'inout';

/** A single I/O variable extracted from ST code */
export interface ExtractedIoVariable {
  /** Variable name as declared in ST code (e.g. "water_temp") */
  name: string;
  /** IEC 61131-3 data type (e.g. "REAL", "BOOL", "INT") */
  dataType: string;
  /** Whether it's an input, output, or bidirectional variable */
  direction: IoDirection;
  /** The VAR block kind from the AST (e.g. "VAR_INPUT") */
  scope: VarBlockKind;
  /** Initial value expression as raw text, if any */
  initialValue?: string;
  /** Source line number (1-based) where the declaration starts */
  line: number;
  /** Source column number (1-based) */
  column: number;
}

/** Binding status for an I/O variable */
export type BindingStatus = 'bound' | 'unbound' | 'mismatch';

/** An I/O variable with its binding status checked against saved ProgramVariables */
export interface IoVariableWithBinding extends ExtractedIoVariable {
  /** Whether this variable is bound to a device I/O tag */
  status: BindingStatus;
  /** The bound I/O tag name (from ProgramVariable.ioTagName), if any */
  boundTagName?: string;
  /** The bound DeviceIoConfig ID, if any */
  boundIoConfigId?: string;
  /** Warning message if there's a problem with the binding */
  warning?: string;
}

/** Summary of tag extraction results */
export interface TagExtractionResult {
  /** All I/O variables found in the ST code */
  ioVariables: ExtractedIoVariable[];
  /** Count of VAR_INPUT variables */
  inputCount: number;
  /** Count of VAR_OUTPUT variables */
  outputCount: number;
  /** Count of VAR_IN_OUT variables */
  inoutCount: number;
  /** Parse errors encountered during extraction */
  parseErrors: Array<{ message: string; line: number; col: number }>;
}

/** Existing program variable record (subset of ProgramVariable fields) */
export interface ExistingVariable {
  varName: string;
  scope: string;
  ioTagName?: string;
  ioConfigId?: string;
  dataType?: string;
}

/** Device I/O tag for matching (subset of DeviceIoConfig fields) */
export interface DeviceTag {
  id: string;
  tagName: string;
  ioType: string; // AI, AO, DI, DO
  dataType: string; // float32, int16, bool, etc.
  description?: string;
}

/** A suggested automatic binding between an ST variable and a device tag */
export interface TagBindingSuggestion {
  /** The I/O variable name from ST code */
  variableName: string;
  /** The suggested device tag */
  suggestedTag: DeviceTag;
  /** How the match was determined */
  matchType: 'exact' | 'normalized' | 'partial';
  /** Confidence score 0-1 */
  confidence: number;
}

// ────────────────────────────────────────────────────────────────────────────
// VAR block kind to direction mapping
// ────────────────────────────────────────────────────────────────────────────

const SCOPE_TO_DIRECTION: Record<string, IoDirection> = {
  VAR_INPUT: 'input',
  VAR_OUTPUT: 'output',
  VAR_IN_OUT: 'inout',
};

const IO_SCOPES = new Set<VarBlockKind>(['VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT']);

// ────────────────────────────────────────────────────────────────────────────
// Type node to string helper
// ────────────────────────────────────────────────────────────────────────────

function typeNodeToString(type: TypeNode): string {
  switch (type.kind) {
    case 'elementaryType':
      return type.name;
    case 'namedType':
      return type.name;
    case 'arrayType': {
      const dims = type.dimensions
        .map((d) => `${exprToString(d.lower)}..${exprToString(d.upper)}`)
        .join(', ');
      return `ARRAY[${dims}] OF ${typeNodeToString(type.elementType)}`;
    }
    case 'stringType':
      return type.baseType;
    default:
      return 'UNKNOWN';
  }
}

function exprToString(expr: unknown): string {
  if (!expr || typeof expr !== 'object') return '?';
  const e = expr as Record<string, unknown>;
  if (e.kind === 'integerLiteral') return String(e.value);
  if (e.kind === 'realLiteral') return String(e.value);
  if (e.kind === 'booleanLiteral') return (e.value as boolean) ? 'TRUE' : 'FALSE';
  if (e.kind === 'stringLiteral') return `'${e.value}'`;
  if (e.kind === 'timeLiteral') return String(e.raw);
  if (e.kind === 'identifier') return String(e.name);
  if (e.kind === 'unaryExpression') return `${e.operator}${exprToString(e.operand)}`;
  return '?';
}

// ────────────────────────────────────────────────────────────────────────────
// Core extraction function
// ────────────────────────────────────────────────────────────────────────────

/**
 * Extract all I/O variable declarations (VAR_INPUT, VAR_OUTPUT, VAR_IN_OUT)
 * from an IEC 61131-3 Structured Text source string.
 */
export function extractIoVariables(stCode: string): TagExtractionResult {
  if (!stCode || stCode.trim().length === 0) {
    return { ioVariables: [], inputCount: 0, outputCount: 0, inoutCount: 0, parseErrors: [] };
  }

  const { ast, errors } = parseST(stCode);

  const ioVariables: ExtractedIoVariable[] = [];

  // Walk all top-level AST nodes (PROGRAMs, FUNCTION_BLOCKs, FUNCTIONs)
  for (const node of ast) {
    const varBlocks = getVarBlocks(node);
    for (const block of varBlocks) {
      if (!IO_SCOPES.has(block.blockType)) continue;

      const direction = SCOPE_TO_DIRECTION[block.blockType];
      if (!direction) continue;

      for (const decl of block.declarations) {
        const dataType = typeNodeToString(decl.type);
        const initialValue = decl.initialValue
          ? exprToString(decl.initialValue)
          : undefined;

        for (const name of decl.names) {
          ioVariables.push({
            name,
            dataType,
            direction,
            scope: block.blockType,
            initialValue,
            line: decl.location.startLine,
            column: decl.location.startCol,
          });
        }
      }
    }
  }

  return {
    ioVariables,
    inputCount: ioVariables.filter((v) => v.direction === 'input').length,
    outputCount: ioVariables.filter((v) => v.direction === 'output').length,
    inoutCount: ioVariables.filter((v) => v.direction === 'inout').length,
    parseErrors: errors.map((e) => ({ message: e.message, line: e.line, col: e.col })),
  };
}

/** Get VAR blocks from any top-level AST node */
function getVarBlocks(node: ASTNode): VarBlockNode[] {
  switch (node.kind) {
    case 'program':
    case 'functionBlock':
    case 'function':
      return node.varBlocks;
    default:
      return [];
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Binding analysis
// ────────────────────────────────────────────────────────────────────────────

/**
 * Cross-reference extracted I/O variables with existing ProgramVariable records
 * to determine binding status.
 *
 * A variable is "bound" if there's a matching ProgramVariable with a non-empty
 * ioTagName. It's "unbound" if no matching record exists or the record has no
 * ioTagName. It's "mismatch" if the data types don't align.
 */
export function analyzeBindings(
  extracted: ExtractedIoVariable[],
  existingVariables: ExistingVariable[],
): IoVariableWithBinding[] {
  // Build lookup by normalized variable name
  const existingMap = new Map<string, ExistingVariable>();
  for (const v of existingVariables) {
    existingMap.set(v.varName.toLowerCase(), v);
  }

  return extracted.map((ioVar) => {
    const existing = existingMap.get(ioVar.name.toLowerCase());

    if (!existing) {
      return {
        ...ioVar,
        status: 'unbound' as BindingStatus,
        warning: 'Bu I/O degiskeni henuz programa eklenmedi. Degiskenler sekmesinden ekleyin ve bir I/O tag baglayiniz.',
      };
    }

    if (!existing.ioTagName) {
      return {
        ...ioVar,
        status: 'unbound' as BindingStatus,
        warning: 'Degisken mevcut ancak fiziksel bir I/O tag\'a baglanmamis. Degiskenler sekmesinden baglayin.',
      };
    }

    // Check for data type mismatch (basic check)
    const typeMatch = checkTypeCompatibility(ioVar.dataType, existing.dataType || '');
    if (!typeMatch) {
      return {
        ...ioVar,
        status: 'mismatch' as BindingStatus,
        boundTagName: existing.ioTagName,
        boundIoConfigId: existing.ioConfigId,
        warning: `Veri tipi uyusmazligi: ST kodu "${ioVar.dataType}" tanimladi, ProgramVariable "${existing.dataType}" olarak kayitli.`,
      };
    }

    return {
      ...ioVar,
      status: 'bound' as BindingStatus,
      boundTagName: existing.ioTagName,
      boundIoConfigId: existing.ioConfigId,
    };
  });
}

/**
 * Check if two IEC 61131-3 data type strings are compatible.
 * Very forgiving: accepts if types match after normalization, or if both
 * are in the same "category" (e.g. INT/DINT are both integer types).
 */
function checkTypeCompatibility(stType: string, dbType: string): boolean {
  if (!stType || !dbType) return true; // Skip check if either is empty

  const a = stType.toUpperCase();
  const b = dbType.toUpperCase();

  if (a === b) return true;

  // Integer family
  const intTypes = new Set(['INT', 'DINT', 'SINT', 'LINT', 'UINT', 'UDINT', 'USINT', 'ULINT']);
  if (intTypes.has(a) && intTypes.has(b)) return true;

  // Real family
  const realTypes = new Set(['REAL', 'LREAL']);
  if (realTypes.has(a) && realTypes.has(b)) return true;

  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Automatic tag binding suggestions
// ────────────────────────────────────────────────────────────────────────────

/**
 * Given a list of unbound I/O variables and available device tags, suggest
 * automatic bindings based on name matching.
 *
 * Matching strategies (in order of confidence):
 * 1. Exact match: variable name === tag name (case-insensitive)
 * 2. Normalized match: normalize both (strip underscores, lowercase) and compare
 * 3. Partial match: one contains the other
 *
 * Also checks I/O direction compatibility:
 * - VAR_INPUT variables should bind to input tags (AI, DI)
 * - VAR_OUTPUT variables should bind to output tags (AO, DO)
 * - VAR_IN_OUT can bind to either
 */
export function suggestTagBindings(
  unboundVariables: ExtractedIoVariable[],
  availableTags: DeviceTag[],
): TagBindingSuggestion[] {
  const suggestions: TagBindingSuggestion[] = [];

  for (const ioVar of unboundVariables) {
    const varNameLower = ioVar.name.toLowerCase();
    const varNameNormalized = normalize(ioVar.name);

    let bestMatch: { tag: DeviceTag; matchType: 'exact' | 'normalized' | 'partial'; confidence: number } | null = null;

    for (const tag of availableTags) {
      // Check direction compatibility
      if (!isDirectionCompatible(ioVar.direction, tag.ioType)) continue;

      const tagNameLower = tag.tagName.toLowerCase();
      const tagNameNormalized = normalize(tag.tagName);

      // Exact match (case-insensitive)
      if (varNameLower === tagNameLower) {
        bestMatch = { tag, matchType: 'exact', confidence: 1.0 };
        break; // Can't do better than exact
      }

      // Normalized match (strip non-alphanumeric)
      if (varNameNormalized === tagNameNormalized && varNameNormalized.length > 2) {
        if (!bestMatch || bestMatch.confidence < 0.8) {
          bestMatch = { tag, matchType: 'normalized', confidence: 0.8 };
        }
      }

      // Partial match: one contains the other
      if (varNameLower.length >= 3 && tagNameLower.length >= 3) {
        if (tagNameLower.includes(varNameLower) || varNameLower.includes(tagNameLower)) {
          if (!bestMatch || bestMatch.confidence < 0.5) {
            bestMatch = { tag, matchType: 'partial', confidence: 0.5 };
          }
        }
      }
    }

    if (bestMatch) {
      suggestions.push({
        variableName: ioVar.name,
        suggestedTag: bestMatch.tag,
        matchType: bestMatch.matchType,
        confidence: bestMatch.confidence,
      });
    }
  }

  return suggestions;
}

/** Normalize a name for fuzzy comparison: lowercase, strip underscores and non-alpha */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Check if an I/O variable direction is compatible with a tag's I/O type */
function isDirectionCompatible(direction: IoDirection, ioType: string): boolean {
  const type = ioType.toUpperCase();
  switch (direction) {
    case 'input':
      return type === 'AI' || type === 'DI';
    case 'output':
      return type === 'AO' || type === 'DO';
    case 'inout':
      return true; // Bidirectional can bind to anything
    default:
      return false;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Data type compatibility for tag suggestions
// ────────────────────────────────────────────────────────────────────────────

/** Maps hardware I/O data types to IEC 61131-3 types */
export const IO_TO_IEC_TYPE: Record<string, string> = {
  bool: 'BOOL',
  int16: 'INT',
  int32: 'DINT',
  uint16: 'UINT',
  uint32: 'UDINT',
  float32: 'REAL',
  float64: 'LREAL',
};

/** Maps IEC 61131-3 types to their compatible hardware types */
export const IEC_TO_IO_TYPES: Record<string, string[]> = {
  BOOL: ['bool'],
  INT: ['int16', 'int32', 'uint16'],
  DINT: ['int32', 'uint32'],
  UINT: ['uint16'],
  UDINT: ['uint32'],
  REAL: ['float32'],
  LREAL: ['float64', 'float32'],
};
