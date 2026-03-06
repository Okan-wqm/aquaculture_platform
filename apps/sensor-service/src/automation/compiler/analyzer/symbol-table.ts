/**
 * IEC 61131-3 Structured Text - Scope-Aware Symbol Table
 *
 * Manages nested scopes (global -> program -> function -> block)
 * with symbol definition, resolution, and usage tracking.
 */

import { SourceRange } from '../compiler.types';

// ────────────────────────────────────────────────────────────────────────────
// Data Types
// ────────────────────────────────────────────────────────────────────────────

/** IEC 61131-3 elementary data type identifiers */
export type ElementaryType =
  | 'BOOL'
  | 'BYTE' | 'WORD' | 'DWORD' | 'LWORD'
  | 'SINT' | 'INT' | 'DINT' | 'LINT'
  | 'USINT' | 'UINT' | 'UDINT' | 'ULINT'
  | 'REAL' | 'LREAL'
  | 'STRING' | 'WSTRING'
  | 'TIME' | 'DATE' | 'TOD' | 'DT'
  | 'ANY' | 'ANY_NUM' | 'ANY_INT' | 'ANY_REAL' | 'ANY_BIT' | 'ANY_STRING' | 'ANY_DATE'
  | 'VOID';

/** Array type descriptor */
export interface ArrayType {
  kind: 'array';
  elementType: DataType;
  lowerBound: number;
  upperBound: number;
}

/** Struct field */
export interface StructField {
  name: string;
  type: DataType;
}

/** Struct type descriptor */
export interface StructType {
  kind: 'struct';
  name: string;
  fields: StructField[];
}

/** Enum type descriptor */
export interface EnumType {
  kind: 'enum';
  name: string;
  values: string[];
}

/** Function block type descriptor */
export interface FunctionBlockType {
  kind: 'functionBlock';
  name: string;
  inputs: FBParameter[];
  outputs: FBParameter[];
  inOuts?: FBParameter[];
}

/** FB parameter */
export interface FBParameter {
  name: string;
  type: DataType;
  defaultValue?: string;
}

/** Unified data type */
export type DataType =
  | { kind: 'elementary'; type: ElementaryType }
  | ArrayType
  | StructType
  | EnumType
  | FunctionBlockType
  | { kind: 'userDefined'; name: string }
  | { kind: 'unknown' };

// ────────────────────────────────────────────────────────────────────────────
// Symbol & Scope
// ────────────────────────────────────────────────────────────────────────────

/** Variable scope qualifier */
export type VariableScope =
  | 'VAR'
  | 'VAR_INPUT'
  | 'VAR_OUTPUT'
  | 'VAR_IN_OUT'
  | 'VAR_GLOBAL'
  | 'VAR_TEMP'
  | 'VAR_EXTERNAL';

/** Symbol kind */
export type SymbolKind =
  | 'variable'
  | 'function'
  | 'functionBlock'
  | 'program'
  | 'type'
  | 'constant'
  | 'parameter'
  | 'enumValue';

/** A symbol in the table */
export interface Symbol {
  name: string;
  kind: SymbolKind;
  dataType: DataType;
  scope: VariableScope;
  location: SourceRange;
  isUsed: boolean;
  isWritten: boolean;
  isConstant: boolean;
  /** For functions: return type */
  returnType?: DataType;
  /** For functions/FBs: parameters */
  parameters?: FunctionParameter[];
}

/** Function parameter descriptor */
export interface FunctionParameter {
  name: string;
  type: DataType;
  direction: 'input' | 'output' | 'inOut';
  defaultValue?: string;
}

/** Scope classification */
export type ScopeKind = 'global' | 'program' | 'functionBlock' | 'function' | 'block';

/** A single scope level */
interface Scope {
  name: string;
  kind: ScopeKind;
  symbols: Map<string, Symbol>;
  parent: Scope | null;
}

// ────────────────────────────────────────────────────────────────────────────
// Helper: create elementary DataType
// ────────────────────────────────────────────────────────────────────────────

export function elementary(type: ElementaryType): DataType {
  return { kind: 'elementary', type };
}

// ────────────────────────────────────────────────────────────────────────────
// Symbol Table
// ────────────────────────────────────────────────────────────────────────────

export class SymbolTable {
  private globalScope: Scope;
  private currentScope: Scope;

  constructor() {
    this.globalScope = { name: 'global', kind: 'global', symbols: new Map(), parent: null };
    this.currentScope = this.globalScope;
    this.initBuiltins();
  }

  // ── Scope management ───────────────────────────────────────────────────

  /** Enter a new nested scope */
  enterScope(name: string, kind: ScopeKind): void {
    const newScope: Scope = {
      name,
      kind,
      symbols: new Map(),
      parent: this.currentScope,
    };
    this.currentScope = newScope;
  }

  /** Exit current scope, returning to parent */
  exitScope(): void {
    if (this.currentScope.parent) {
      this.currentScope = this.currentScope.parent;
    }
  }

  /** Get current scope kind */
  getCurrentScopeKind(): ScopeKind {
    return this.currentScope.kind;
  }

  /** Get current scope name */
  getCurrentScopeName(): string {
    return this.currentScope.name;
  }

  // ── Symbol operations ──────────────────────────────────────────────────

  /**
   * Define a symbol in the current scope.
   * Returns false if already defined in the current scope.
   */
  define(symbol: Symbol): boolean {
    const key = symbol.name.toUpperCase();
    if (this.currentScope.symbols.has(key)) {
      return false; // duplicate
    }
    this.currentScope.symbols.set(key, symbol);
    return true;
  }

  /**
   * Resolve a symbol by searching up the scope chain.
   * IEC 61131-3 uses case-insensitive identifiers.
   */
  resolve(name: string): Symbol | undefined {
    const key = name.toUpperCase();
    let scope: Scope | null = this.currentScope;
    while (scope) {
      const sym = scope.symbols.get(key);
      if (sym) return sym;
      scope = scope.parent;
    }
    return undefined;
  }

  /** Resolve only in the current scope (no parent search) */
  resolveLocal(name: string): Symbol | undefined {
    return this.currentScope.symbols.get(name.toUpperCase());
  }

  /** Mark a symbol as used */
  markUsed(name: string): void {
    const sym = this.resolve(name);
    if (sym) sym.isUsed = true;
  }

  /** Mark a symbol as written */
  markWritten(name: string): void {
    const sym = this.resolve(name);
    if (sym) sym.isWritten = true;
  }

  // ── Queries ────────────────────────────────────────────────────────────

  /** Get all symbols across all reachable scopes */
  getAllSymbols(): Symbol[] {
    const result: Symbol[] = [];
    let scope: Scope | null = this.currentScope;
    while (scope) {
      for (const sym of scope.symbols.values()) {
        result.push(sym);
      }
      scope = scope.parent;
    }
    return result;
  }

  /** Get symbols from the current scope that are unused variables */
  getUnusedSymbols(): Symbol[] {
    const result: Symbol[] = [];
    const collectUnused = (scope: Scope): void => {
      for (const sym of scope.symbols.values()) {
        if (!sym.isUsed && (sym.kind === 'variable' || sym.kind === 'parameter')) {
          result.push(sym);
        }
      }
    };
    let scope: Scope | null = this.currentScope;
    while (scope && scope.kind !== 'global') {
      collectUnused(scope);
      scope = scope.parent;
    }
    return result;
  }

  /** Check if we are inside a loop (FOR/WHILE/REPEAT) */
  isInsideLoop(): boolean {
    let scope: Scope | null = this.currentScope;
    while (scope) {
      if (scope.kind === 'block' && (
        scope.name === 'FOR' || scope.name === 'WHILE' || scope.name === 'REPEAT'
      )) {
        return true;
      }
      scope = scope.parent;
    }
    return false;
  }

  /** Check if we are inside a function (for RETURN checks) */
  isInsideFunction(): boolean {
    let scope: Scope | null = this.currentScope;
    while (scope) {
      if (scope.kind === 'function') return true;
      scope = scope.parent;
    }
    return false;
  }

  /** Get the current POU kind (program/function/functionBlock) */
  getCurrentPOUKind(): ScopeKind | null {
    let scope: Scope | null = this.currentScope;
    while (scope) {
      if (scope.kind === 'program' || scope.kind === 'function' || scope.kind === 'functionBlock') {
        return scope.kind;
      }
      scope = scope.parent;
    }
    return null;
  }

  // ── Built-in initialization ────────────────────────────────────────────

  private initBuiltins(): void {
    const noLoc: SourceRange = { startLine: 0, startCol: 0, endLine: 0, endCol: 0 };

    // -- Standard functions --
    const stdFunctions: Array<{ name: string; params: DataType[]; ret: DataType }> = [
      // Math
      { name: 'ABS', params: [elementary('ANY_NUM')], ret: elementary('ANY_NUM') },
      { name: 'SQRT', params: [elementary('ANY_REAL')], ret: elementary('ANY_REAL') },
      { name: 'LN', params: [elementary('ANY_REAL')], ret: elementary('ANY_REAL') },
      { name: 'LOG', params: [elementary('ANY_REAL')], ret: elementary('ANY_REAL') },
      { name: 'EXP', params: [elementary('ANY_REAL')], ret: elementary('ANY_REAL') },
      { name: 'EXPT', params: [elementary('ANY_REAL'), elementary('ANY_NUM')], ret: elementary('ANY_REAL') },
      { name: 'SIN', params: [elementary('ANY_REAL')], ret: elementary('ANY_REAL') },
      { name: 'COS', params: [elementary('ANY_REAL')], ret: elementary('ANY_REAL') },
      { name: 'TAN', params: [elementary('ANY_REAL')], ret: elementary('ANY_REAL') },
      { name: 'ASIN', params: [elementary('ANY_REAL')], ret: elementary('ANY_REAL') },
      { name: 'ACOS', params: [elementary('ANY_REAL')], ret: elementary('ANY_REAL') },
      { name: 'ATAN', params: [elementary('ANY_REAL')], ret: elementary('ANY_REAL') },
      { name: 'ATAN2', params: [elementary('ANY_REAL'), elementary('ANY_REAL')], ret: elementary('ANY_REAL') },
      { name: 'TRUNC', params: [elementary('ANY_REAL')], ret: elementary('ANY_INT') },
      // Selection/limit
      { name: 'MAX', params: [elementary('ANY'), elementary('ANY')], ret: elementary('ANY') },
      { name: 'MIN', params: [elementary('ANY'), elementary('ANY')], ret: elementary('ANY') },
      { name: 'LIMIT', params: [elementary('ANY'), elementary('ANY'), elementary('ANY')], ret: elementary('ANY') },
      { name: 'SEL', params: [elementary('BOOL'), elementary('ANY'), elementary('ANY')], ret: elementary('ANY') },
      { name: 'MUX', params: [elementary('ANY_INT'), elementary('ANY'), elementary('ANY')], ret: elementary('ANY') },
      { name: 'MOVE', params: [elementary('ANY')], ret: elementary('ANY') },
      // String
      { name: 'LEN', params: [elementary('STRING')], ret: elementary('INT') },
      { name: 'LEFT', params: [elementary('STRING'), elementary('INT')], ret: elementary('STRING') },
      { name: 'RIGHT', params: [elementary('STRING'), elementary('INT')], ret: elementary('STRING') },
      { name: 'MID', params: [elementary('STRING'), elementary('INT'), elementary('INT')], ret: elementary('STRING') },
      { name: 'CONCAT', params: [elementary('STRING'), elementary('STRING')], ret: elementary('STRING') },
      { name: 'INSERT', params: [elementary('STRING'), elementary('STRING'), elementary('INT')], ret: elementary('STRING') },
      { name: 'DELETE', params: [elementary('STRING'), elementary('INT'), elementary('INT')], ret: elementary('STRING') },
      { name: 'REPLACE', params: [elementary('STRING'), elementary('STRING'), elementary('INT'), elementary('INT')], ret: elementary('STRING') },
      { name: 'FIND', params: [elementary('STRING'), elementary('STRING')], ret: elementary('INT') },
      // Bit manipulation
      { name: 'SHL', params: [elementary('ANY_BIT'), elementary('ANY_INT')], ret: elementary('ANY_BIT') },
      { name: 'SHR', params: [elementary('ANY_BIT'), elementary('ANY_INT')], ret: elementary('ANY_BIT') },
      { name: 'ROL', params: [elementary('ANY_BIT'), elementary('ANY_INT')], ret: elementary('ANY_BIT') },
      { name: 'ROR', params: [elementary('ANY_BIT'), elementary('ANY_INT')], ret: elementary('ANY_BIT') },
    ];

    for (const fn of stdFunctions) {
      const params: FunctionParameter[] = fn.params.map((t, i) => ({
        name: `IN${fn.params.length > 1 ? (i + 1).toString() : ''}`,
        type: t,
        direction: 'input' as const,
      }));
      this.globalScope.symbols.set(fn.name, {
        name: fn.name,
        kind: 'function',
        dataType: fn.ret,
        scope: 'VAR',
        location: noLoc,
        isUsed: true,
        isWritten: false,
        isConstant: false,
        returnType: fn.ret,
        parameters: params,
      });
    }

    // -- Type conversion functions (*_TO_*) --
    const numericTypes: ElementaryType[] = ['BOOL', 'SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT', 'REAL', 'LREAL'];
    const allConvTypes: ElementaryType[] = [...numericTypes, 'STRING', 'TIME', 'DATE', 'TOD', 'DT', 'BYTE', 'WORD', 'DWORD', 'LWORD'];
    for (const from of allConvTypes) {
      for (const to of allConvTypes) {
        if (from === to) continue;
        const name = `${from}_TO_${to}`;
        if (!this.globalScope.symbols.has(name)) {
          this.globalScope.symbols.set(name, {
            name,
            kind: 'function',
            dataType: elementary(to),
            scope: 'VAR',
            location: noLoc,
            isUsed: true,
            isWritten: false,
            isConstant: false,
            returnType: elementary(to),
            parameters: [{ name: 'IN', type: elementary(from), direction: 'input' }],
          });
        }
      }
    }

    // -- Standard function blocks --
    const stdFBs: Array<{ name: string; inputs: FBParameter[]; outputs: FBParameter[] }> = [
      {
        name: 'TON',
        inputs: [{ name: 'IN', type: elementary('BOOL') }, { name: 'PT', type: elementary('TIME') }],
        outputs: [{ name: 'Q', type: elementary('BOOL') }, { name: 'ET', type: elementary('TIME') }],
      },
      {
        name: 'TOF',
        inputs: [{ name: 'IN', type: elementary('BOOL') }, { name: 'PT', type: elementary('TIME') }],
        outputs: [{ name: 'Q', type: elementary('BOOL') }, { name: 'ET', type: elementary('TIME') }],
      },
      {
        name: 'TP',
        inputs: [{ name: 'IN', type: elementary('BOOL') }, { name: 'PT', type: elementary('TIME') }],
        outputs: [{ name: 'Q', type: elementary('BOOL') }, { name: 'ET', type: elementary('TIME') }],
      },
      {
        name: 'CTU',
        inputs: [{ name: 'CU', type: elementary('BOOL') }, { name: 'R', type: elementary('BOOL') }, { name: 'PV', type: elementary('INT') }],
        outputs: [{ name: 'Q', type: elementary('BOOL') }, { name: 'CV', type: elementary('INT') }],
      },
      {
        name: 'CTD',
        inputs: [{ name: 'CD', type: elementary('BOOL') }, { name: 'LD', type: elementary('BOOL') }, { name: 'PV', type: elementary('INT') }],
        outputs: [{ name: 'Q', type: elementary('BOOL') }, { name: 'CV', type: elementary('INT') }],
      },
      {
        name: 'CTUD',
        inputs: [
          { name: 'CU', type: elementary('BOOL') }, { name: 'CD', type: elementary('BOOL') },
          { name: 'R', type: elementary('BOOL') }, { name: 'LD', type: elementary('BOOL') },
          { name: 'PV', type: elementary('INT') },
        ],
        outputs: [{ name: 'QU', type: elementary('BOOL') }, { name: 'QD', type: elementary('BOOL') }, { name: 'CV', type: elementary('INT') }],
      },
      {
        name: 'SR',
        inputs: [{ name: 'S1', type: elementary('BOOL') }, { name: 'R', type: elementary('BOOL') }],
        outputs: [{ name: 'Q1', type: elementary('BOOL') }],
      },
      {
        name: 'RS',
        inputs: [{ name: 'S', type: elementary('BOOL') }, { name: 'R1', type: elementary('BOOL') }],
        outputs: [{ name: 'Q1', type: elementary('BOOL') }],
      },
      {
        name: 'R_TRIG',
        inputs: [{ name: 'CLK', type: elementary('BOOL') }],
        outputs: [{ name: 'Q', type: elementary('BOOL') }],
      },
      {
        name: 'F_TRIG',
        inputs: [{ name: 'CLK', type: elementary('BOOL') }],
        outputs: [{ name: 'Q', type: elementary('BOOL') }],
      },
      {
        name: 'PID',
        inputs: [
          { name: 'SETPOINT', type: elementary('REAL') }, { name: 'PV', type: elementary('REAL') },
          { name: 'KP', type: elementary('REAL') }, { name: 'KI', type: elementary('REAL') },
          { name: 'KD', type: elementary('REAL') },
        ],
        outputs: [{ name: 'OUT', type: elementary('REAL') }],
      },
      {
        name: 'HYSTERESIS',
        inputs: [{ name: 'IN', type: elementary('REAL') }, { name: 'HIGH', type: elementary('REAL') }, { name: 'LOW', type: elementary('REAL') }],
        outputs: [{ name: 'Q', type: elementary('BOOL') }],
      },
      {
        name: 'MAVG',
        inputs: [{ name: 'IN', type: elementary('REAL') }, { name: 'N', type: elementary('INT') }],
        outputs: [{ name: 'OUT', type: elementary('REAL') }],
      },
      {
        name: 'RAMP',
        inputs: [{ name: 'IN', type: elementary('REAL') }, { name: 'RATE', type: elementary('REAL') }, { name: 'CYCLE', type: elementary('TIME') }],
        outputs: [{ name: 'OUT', type: elementary('REAL') }],
      },
      {
        name: 'BLINK',
        inputs: [{ name: 'ENABLE', type: elementary('BOOL') }, { name: 'TIMELOW', type: elementary('TIME') }, { name: 'TIMEHIGH', type: elementary('TIME') }],
        outputs: [{ name: 'Q', type: elementary('BOOL') }],
      },
      {
        name: 'DERIVATIVE',
        inputs: [{ name: 'IN', type: elementary('REAL') }, { name: 'CYCLE', type: elementary('TIME') }],
        outputs: [{ name: 'OUT', type: elementary('REAL') }],
      },
      {
        name: 'INTEGRAL',
        inputs: [{ name: 'IN', type: elementary('REAL') }, { name: 'CYCLE', type: elementary('TIME') }, { name: 'R', type: elementary('BOOL') }],
        outputs: [{ name: 'OUT', type: elementary('REAL') }],
      },
      {
        name: 'PID_COMPACT',
        inputs: [{ name: 'SETPOINT', type: elementary('REAL') }, { name: 'INPUT', type: elementary('REAL') }, { name: 'MANUAL', type: elementary('BOOL') }],
        outputs: [{ name: 'OUTPUT', type: elementary('REAL') }, { name: 'STATE', type: elementary('INT') }],
      },
      {
        name: 'SEMA',
        inputs: [{ name: 'CLAIM', type: elementary('BOOL') }, { name: 'RELEASE', type: elementary('BOOL') }],
        outputs: [{ name: 'BUSY', type: elementary('BOOL') }],
      },
      {
        name: 'LIMITALARM',
        inputs: [
          { name: 'IN', type: elementary('REAL') },
          { name: 'HH', type: elementary('REAL') }, { name: 'H', type: elementary('REAL') },
          { name: 'L', type: elementary('REAL') }, { name: 'LL', type: elementary('REAL') },
        ],
        outputs: [
          { name: 'QHH', type: elementary('BOOL') }, { name: 'QH', type: elementary('BOOL') },
          { name: 'QL', type: elementary('BOOL') }, { name: 'QLL', type: elementary('BOOL') },
        ],
      },
      {
        name: 'SCALE',
        inputs: [
          { name: 'IN', type: elementary('REAL') },
          { name: 'IN_MIN', type: elementary('REAL') }, { name: 'IN_MAX', type: elementary('REAL') },
          { name: 'OUT_MIN', type: elementary('REAL') }, { name: 'OUT_MAX', type: elementary('REAL') },
        ],
        outputs: [{ name: 'OUT', type: elementary('REAL') }],
      },
      {
        name: 'DEADBAND',
        inputs: [{ name: 'IN', type: elementary('REAL') }, { name: 'DB', type: elementary('REAL') }, { name: 'LAST', type: elementary('REAL') }],
        outputs: [{ name: 'OUT', type: elementary('REAL') }],
      },
      {
        name: 'TOTALIZER',
        inputs: [{ name: 'IN', type: elementary('REAL') }, { name: 'CYCLE', type: elementary('TIME') }, { name: 'R', type: elementary('BOOL') }],
        outputs: [{ name: 'OUT', type: elementary('REAL') }],
      },
    ];

    for (const fb of stdFBs) {
      const fbType: FunctionBlockType = {
        kind: 'functionBlock',
        name: fb.name,
        inputs: fb.inputs,
        outputs: fb.outputs,
      };
      this.globalScope.symbols.set(fb.name, {
        name: fb.name,
        kind: 'functionBlock',
        dataType: fbType,
        scope: 'VAR',
        location: noLoc,
        isUsed: true,
        isWritten: false,
        isConstant: false,
      });
    }
  }
}
