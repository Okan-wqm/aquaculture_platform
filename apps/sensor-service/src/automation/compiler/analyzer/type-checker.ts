/**
 * IEC 61131-3 Structured Text - Type Checker
 *
 * Implements the IEC 61131-3 type system including:
 * - Type compatibility and assignment rules
 * - Implicit widening conversions
 * - Binary/unary expression type inference
 * - TIME arithmetic rules
 */

import {
  DataType,
  ElementaryType,
  elementary,
  FunctionParameter,
} from './symbol-table';

// ────────────────────────────────────────────────────────────────────────────
// Type category sets
// ────────────────────────────────────────────────────────────────────────────

const SIGNED_INT_TYPES: ReadonlySet<ElementaryType> = new Set(['SINT', 'INT', 'DINT', 'LINT']);
const UNSIGNED_INT_TYPES: ReadonlySet<ElementaryType> = new Set(['USINT', 'UINT', 'UDINT', 'ULINT']);
const ALL_INT_TYPES: ReadonlySet<ElementaryType> = new Set([...SIGNED_INT_TYPES, ...UNSIGNED_INT_TYPES]);
const REAL_TYPES: ReadonlySet<ElementaryType> = new Set(['REAL', 'LREAL']);
const NUMERIC_TYPES: ReadonlySet<ElementaryType> = new Set([...ALL_INT_TYPES, ...REAL_TYPES]);
const BIT_TYPES: ReadonlySet<ElementaryType> = new Set(['BYTE', 'WORD', 'DWORD', 'LWORD']);
const DATE_TYPES: ReadonlySet<ElementaryType> = new Set(['DATE', 'TOD', 'DT']);
const STRING_TYPES: ReadonlySet<ElementaryType> = new Set(['STRING', 'WSTRING']);

/** Implicit widening rank: lower number = smaller type */
const SIGNED_INT_RANK: ReadonlyMap<ElementaryType, number> = new Map([
  ['SINT', 1], ['INT', 2], ['DINT', 3], ['LINT', 4],
]);

const UNSIGNED_INT_RANK: ReadonlyMap<ElementaryType, number> = new Map([
  ['USINT', 1], ['UINT', 2], ['UDINT', 3], ['ULINT', 4],
]);

const REAL_RANK: ReadonlyMap<ElementaryType, number> = new Map([
  ['REAL', 1], ['LREAL', 2],
]);

const BIT_RANK: ReadonlyMap<ElementaryType, number> = new Map([
  ['BYTE', 1], ['WORD', 2], ['DWORD', 3], ['LWORD', 4],
]);

// ────────────────────────────────────────────────────────────────────────────
// Type Checker
// ────────────────────────────────────────────────────────────────────────────

export class TypeChecker {

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Check if source type can be assigned to target type.
   * Follows IEC 61131-3 implicit conversion rules.
   */
  isAssignableTo(source: DataType, target: DataType): boolean {
    // Unknown types are permissive (avoid cascading errors)
    if (source.kind === 'unknown' || target.kind === 'unknown') return true;

    // Same type
    if (this.isSameType(source, target)) return true;

    // Elementary-to-elementary implicit widening
    if (source.kind === 'elementary' && target.kind === 'elementary') {
      return this.isImplicitlyConvertible(source.type, target.type);
    }

    // Generic type compatibility (ANY, ANY_NUM, etc.)
    if (target.kind === 'elementary' && this.isGenericType(target.type)) {
      return this.matchesGeneric(source, target.type);
    }

    // Array: element type must match, bounds must be compatible
    if (source.kind === 'array' && target.kind === 'array') {
      return this.isAssignableTo(source.elementType, target.elementType);
    }

    // User-defined: name match (case-insensitive)
    if (source.kind === 'userDefined' && target.kind === 'userDefined') {
      return source.name.toUpperCase() === target.name.toUpperCase();
    }

    // FB type match by name
    if (source.kind === 'functionBlock' && target.kind === 'functionBlock') {
      return source.name.toUpperCase() === target.name.toUpperCase();
    }

    return false;
  }

  /**
   * Infer the result type of a binary expression.
   * Returns null if the operation is invalid for the given types.
   */
  inferBinaryExprType(left: DataType, op: string, right: DataType): DataType | null {
    // Unknown propagation
    if (left.kind === 'unknown' || right.kind === 'unknown') return { kind: 'unknown' };

    if (left.kind !== 'elementary' || right.kind !== 'elementary') {
      // Struct/array/FB comparison or arithmetic is not valid
      return null;
    }

    const l = left.type;
    const r = right.type;
    const upperOp = op.toUpperCase();

    // Comparison operators always return BOOL
    if (['=', '<>', '<', '>', '<=', '>='].includes(upperOp)) {
      if (this.areComparable(l, r)) return elementary('BOOL');
      return null;
    }

    // Logical operators: AND, OR, XOR
    if (['AND', 'OR', 'XOR', '&'].includes(upperOp)) {
      // BOOL AND BOOL -> BOOL
      if (l === 'BOOL' && r === 'BOOL') return elementary('BOOL');
      // Bitwise on BIT types
      if (BIT_TYPES.has(l) && BIT_TYPES.has(r)) return elementary(this.widerBitType(l, r));
      return null;
    }

    // Arithmetic: +, -, *, /, MOD, **
    if (['+', '-'].includes(upperOp)) {
      // TIME + TIME -> TIME, TIME - TIME -> TIME
      if (l === 'TIME' && r === 'TIME') return elementary('TIME');
      // DATE + TIME -> DT, DT + TIME -> DT, TOD + TIME -> TOD
      if (l === 'DT' && r === 'TIME') return elementary('DT');
      if (l === 'TOD' && r === 'TIME') return elementary('TOD');
      if (l === 'DATE' && r === 'TIME') return elementary('DT');
      // DT - DT -> TIME, TOD - TOD -> TIME, DATE - DATE -> TIME
      if (upperOp === '-') {
        if (l === 'DT' && r === 'DT') return elementary('TIME');
        if (l === 'TOD' && r === 'TOD') return elementary('TIME');
        if (l === 'DATE' && r === 'DATE') return elementary('TIME');
      }
      // Numeric
      if (NUMERIC_TYPES.has(l) && NUMERIC_TYPES.has(r)) {
        return elementary(this.widerNumericType(l, r));
      }
      // String concatenation
      if (upperOp === '+' && STRING_TYPES.has(l) && STRING_TYPES.has(r)) {
        return elementary('STRING');
      }
      return null;
    }

    if (upperOp === '*') {
      // TIME * INT/REAL -> TIME
      if (l === 'TIME' && NUMERIC_TYPES.has(r)) return elementary('TIME');
      if (NUMERIC_TYPES.has(l) && r === 'TIME') return elementary('TIME');
      // Numeric * Numeric
      if (NUMERIC_TYPES.has(l) && NUMERIC_TYPES.has(r)) {
        return elementary(this.widerNumericType(l, r));
      }
      return null;
    }

    if (upperOp === '/') {
      // TIME / INT/REAL -> TIME
      if (l === 'TIME' && NUMERIC_TYPES.has(r)) return elementary('TIME');
      // Numeric / Numeric
      if (NUMERIC_TYPES.has(l) && NUMERIC_TYPES.has(r)) {
        return elementary(this.widerNumericType(l, r));
      }
      return null;
    }

    if (upperOp === 'MOD') {
      if (ALL_INT_TYPES.has(l) && ALL_INT_TYPES.has(r)) {
        return elementary(this.widerNumericType(l, r));
      }
      return null;
    }

    if (upperOp === '**') {
      if (NUMERIC_TYPES.has(l) && NUMERIC_TYPES.has(r)) {
        return elementary(REAL_TYPES.has(l) ? l : 'REAL');
      }
      return null;
    }

    return null;
  }

  /**
   * Infer the result type of a unary expression.
   */
  inferUnaryExprType(op: string, operand: DataType): DataType | null {
    if (operand.kind === 'unknown') return { kind: 'unknown' };
    if (operand.kind !== 'elementary') return null;

    const t = operand.type;
    const upperOp = op.toUpperCase();

    if (upperOp === 'NOT') {
      if (t === 'BOOL') return elementary('BOOL');
      if (BIT_TYPES.has(t)) return elementary(t);
      return null;
    }

    if (upperOp === '-' || upperOp === '+') {
      if (NUMERIC_TYPES.has(t)) return elementary(t);
      if (t === 'TIME' && upperOp === '-') return elementary('TIME');
      return null;
    }

    return null;
  }

  /**
   * Infer the return type of a function call given argument types.
   * For standard functions, applies IEC 61131-3 overloading rules.
   */
  inferFunctionReturnType(
    returnType: DataType,
    paramDefs: FunctionParameter[],
    argTypes: DataType[],
  ): DataType | null {
    // If return type is a concrete elementary type, just return it
    if (returnType.kind === 'elementary' && !this.isGenericType(returnType.type)) {
      return returnType;
    }

    // For generic return types (ANY, ANY_NUM, etc.), infer from argument types
    if (returnType.kind === 'elementary' && this.isGenericType(returnType.type)) {
      // Find the first concrete argument type that matches the generic
      for (const argType of argTypes) {
        if (argType.kind === 'elementary' && !this.isGenericType(argType.type)) {
          if (this.matchesGeneric(argType, returnType.type)) {
            return argType;
          }
        }
      }
      // Fallback: return the generic itself
      return returnType;
    }

    return returnType;
  }

  /**
   * Check if a type is an integer type (signed or unsigned).
   */
  isIntegerType(dt: DataType): boolean {
    return dt.kind === 'elementary' && ALL_INT_TYPES.has(dt.type);
  }

  /**
   * Check if a type is a numeric type (integer or real).
   */
  isNumericType(dt: DataType): boolean {
    return dt.kind === 'elementary' && NUMERIC_TYPES.has(dt.type);
  }

  /**
   * Check if a type is a BOOL type.
   */
  isBoolType(dt: DataType): boolean {
    return dt.kind === 'elementary' && dt.type === 'BOOL';
  }

  /**
   * Get a human-readable type name.
   */
  typeToString(dt: DataType): string {
    switch (dt.kind) {
      case 'elementary': return dt.type;
      case 'array': return `ARRAY[${(dt as any).lowerBound}..${(dt as any).upperBound}] OF ${this.typeToString(dt.elementType)}`;
      case 'struct': return dt.name;
      case 'enum': return dt.name;
      case 'functionBlock': return dt.name;
      case 'userDefined': return dt.name;
      case 'unknown': return '<unknown>';
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /** Check if two types are structurally identical */
  private isSameType(a: DataType, b: DataType): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'elementary' && b.kind === 'elementary') return a.type === b.type;
    if (a.kind === 'userDefined' && b.kind === 'userDefined') return a.name.toUpperCase() === b.name.toUpperCase();
    if (a.kind === 'functionBlock' && b.kind === 'functionBlock') return a.name.toUpperCase() === b.name.toUpperCase();
    if (a.kind === 'enum' && b.kind === 'enum') return a.name.toUpperCase() === b.name.toUpperCase();
    if (a.kind === 'struct' && b.kind === 'struct') return a.name.toUpperCase() === b.name.toUpperCase();
    if (a.kind === 'array' && b.kind === 'array') {
      return this.isSameType(a.elementType, b.elementType)
        && a.lowerBound === b.lowerBound
        && a.upperBound === b.upperBound;
    }
    return false;
  }

  /** IEC 61131-3 implicit conversion rules (widening only) */
  private isImplicitlyConvertible(from: ElementaryType, to: ElementaryType): boolean {
    if (from === to) return true;

    // Generic types: accept matching categories
    if (this.isGenericType(to)) return this.matchesGenericElem(from, to);

    // SINT -> INT -> DINT -> LINT
    const fromSR = SIGNED_INT_RANK.get(from);
    const toSR = SIGNED_INT_RANK.get(to);
    if (fromSR !== undefined && toSR !== undefined) return fromSR <= toSR;

    // USINT -> UINT -> UDINT -> ULINT
    const fromUR = UNSIGNED_INT_RANK.get(from);
    const toUR = UNSIGNED_INT_RANK.get(to);
    if (fromUR !== undefined && toUR !== undefined) return fromUR <= toUR;

    // REAL -> LREAL
    const fromRR = REAL_RANK.get(from);
    const toRR = REAL_RANK.get(to);
    if (fromRR !== undefined && toRR !== undefined) return fromRR <= toRR;

    // BYTE -> WORD -> DWORD -> LWORD
    const fromBR = BIT_RANK.get(from);
    const toBR = BIT_RANK.get(to);
    if (fromBR !== undefined && toBR !== undefined) return fromBR <= toBR;

    // BOOL -> any integer (widening)
    if (from === 'BOOL' && ALL_INT_TYPES.has(to)) return true;

    return false;
  }

  /** Check if a type is a generic (ANY, ANY_NUM, etc.) */
  private isGenericType(t: ElementaryType): boolean {
    return t === 'ANY' || t === 'ANY_NUM' || t === 'ANY_INT' || t === 'ANY_REAL'
      || t === 'ANY_BIT' || t === 'ANY_STRING' || t === 'ANY_DATE';
  }

  /** Check if a DataType matches a generic category */
  private matchesGeneric(dt: DataType, generic: ElementaryType): boolean {
    if (generic === 'ANY') return true;
    if (dt.kind !== 'elementary') {
      // STRUCT/ARRAY/FB can match ANY
      return (generic as string) === 'ANY';
    }
    return this.matchesGenericElem(dt.type, generic);
  }

  /** Check if an elementary type matches a generic category */
  private matchesGenericElem(t: ElementaryType, generic: ElementaryType): boolean {
    switch (generic) {
      case 'ANY': return true;
      case 'ANY_NUM': return NUMERIC_TYPES.has(t);
      case 'ANY_INT': return ALL_INT_TYPES.has(t);
      case 'ANY_REAL': return REAL_TYPES.has(t);
      case 'ANY_BIT': return BIT_TYPES.has(t) || t === 'BOOL';
      case 'ANY_STRING': return STRING_TYPES.has(t);
      case 'ANY_DATE': return DATE_TYPES.has(t) || t === 'TIME';
      default: return t === generic;
    }
  }

  /** Check if two types are comparable */
  private areComparable(a: ElementaryType, b: ElementaryType): boolean {
    if (a === b) return true;
    // Numeric types can be compared
    if (NUMERIC_TYPES.has(a) && NUMERIC_TYPES.has(b)) return true;
    // String comparison
    if (STRING_TYPES.has(a) && STRING_TYPES.has(b)) return true;
    // Time/Date comparison (same type only)
    if (a === 'TIME' && b === 'TIME') return true;
    if (DATE_TYPES.has(a) && a === b) return true;
    // BOOL comparison
    if (a === 'BOOL' && b === 'BOOL') return true;
    // Bit types
    if (BIT_TYPES.has(a) && BIT_TYPES.has(b)) return true;
    return false;
  }

  /** Find the wider of two numeric types */
  private widerNumericType(a: ElementaryType, b: ElementaryType): ElementaryType {
    // If either is REAL/LREAL, result is real
    if (REAL_TYPES.has(a) || REAL_TYPES.has(b)) {
      const aR = REAL_RANK.get(a) ?? 0;
      const bR = REAL_RANK.get(b) ?? 0;
      if (aR >= bR) return aR > 0 ? a : 'REAL';
      return bR > 0 ? b : 'REAL';
    }
    // Both signed
    const aSR = SIGNED_INT_RANK.get(a);
    const bSR = SIGNED_INT_RANK.get(b);
    if (aSR !== undefined && bSR !== undefined) {
      return aSR >= bSR ? a : b;
    }
    // Both unsigned
    const aUR = UNSIGNED_INT_RANK.get(a);
    const bUR = UNSIGNED_INT_RANK.get(b);
    if (aUR !== undefined && bUR !== undefined) {
      return aUR >= bUR ? a : b;
    }
    // Mixed signed/unsigned: promote to larger signed
    return 'DINT';
  }

  /** Find the wider of two bit types */
  private widerBitType(a: ElementaryType, b: ElementaryType): ElementaryType {
    const aR = BIT_RANK.get(a) ?? 0;
    const bR = BIT_RANK.get(b) ?? 0;
    return aR >= bR ? a : b;
  }
}
