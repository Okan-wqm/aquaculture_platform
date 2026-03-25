/**
 * IEC 61131-3 Structured Text AST Tree-Walker Interpreter
 *
 * Executes a parsed ST program/function_block/function by walking the AST.
 * Each `runCycle()` call executes all body statements once (one PLC scan).
 * Variable state persists between cycles until `reset()`.
 */

import type {
  ASTNode,
  ProgramNode,
  FunctionBlockNode,
  FunctionNode,
  VarBlockNode,
  VarBlockKind,
  VarDeclarationNode,
  TypeNode,
  Statement,
  Expression,
  BinaryOperator,
  UnaryOperator,
  CaseLabel,
} from './st-ast-types';

// ────────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────────

export type SimValue = boolean | number | string;

export interface VariableInfo {
  name: string;
  scope: VarBlockKind;
  dataType: string;
  value: SimValue;
}

// ────────────────────────────────────────────────────────────────────────────
// Internal control-flow signals
// ────────────────────────────────────────────────────────────────────────────

const RETURN_SIGNAL = Symbol('RETURN');
const EXIT_SIGNAL = Symbol('EXIT');

type ControlSignal = typeof RETURN_SIGNAL | typeof EXIT_SIGNAL;

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 100_000;

// ────────────────────────────────────────────────────────────────────────────
// Internal metadata stored alongside each variable
// ────────────────────────────────────────────────────────────────────────────

interface VarMeta {
  originalName: string; // preserves original casing for getVariableInfo()
  scope: VarBlockKind;
  dataType: string;
  defaultValue: SimValue;
}

// ────────────────────────────────────────────────────────────────────────────
// Built-in function registry
// ────────────────────────────────────────────────────────────────────────────

type BuiltinFn = (args: SimValue[]) => SimValue;

function buildBuiltins(): Map<string, BuiltinFn> {
  const m = new Map<string, BuiltinFn>();

  // ── Math ──────────────────────────────────────────────────────────────
  m.set('abs', (a) => Math.abs(toNum(a[0])));
  m.set('sqrt', (a) => {
    const v = toNum(a[0]);
    if (v < 0) {
      console.warn(`ST Interpreter: SQRT of negative number (${v}), returning 0`);
      return 0;
    }
    return Math.sqrt(v);
  });
  m.set('sin', (a) => Math.sin(toNum(a[0])));
  m.set('cos', (a) => Math.cos(toNum(a[0])));
  m.set('tan', (a) => Math.tan(toNum(a[0])));
  m.set('asin', (a) => Math.asin(toNum(a[0])));
  m.set('acos', (a) => Math.acos(toNum(a[0])));
  m.set('atan', (a) => Math.atan(toNum(a[0])));
  m.set('ln', (a) => Math.log(toNum(a[0])));
  m.set('log', (a) => Math.log10(toNum(a[0])));
  m.set('exp', (a) => Math.exp(toNum(a[0])));
  m.set('trunc', (a) => Math.trunc(toNum(a[0])));
  m.set('expt', (a) => Math.pow(toNum(a[0]), toNum(a[1])));

  // ── Selection ─────────────────────────────────────────────────────────
  m.set('min', (a) => Math.min(toNum(a[0]), toNum(a[1])));
  m.set('max', (a) => Math.max(toNum(a[0]), toNum(a[1])));
  m.set('limit', (a) => {
    const mn = toNum(a[0]);
    const val = toNum(a[1]);
    const mx = toNum(a[2]);
    return Math.min(Math.max(val, mn), mx);
  });
  m.set('sel', (a) => {
    // SEL(cond, false_val, true_val)
    const cond = isTruthyStatic(a[0]);
    return cond ? a[2] : a[1];
  });

  // ── Type conversion ───────────────────────────────────────────────────
  m.set('int_to_real', (a) => toNum(a[0]));
  m.set('real_to_int', (a) => Math.trunc(toNum(a[0])));
  m.set('bool_to_int', (a) => (isTruthyStatic(a[0]) ? 1 : 0));
  m.set('int_to_bool', (a) => toNum(a[0]) !== 0);

  return m;
}

/** Coerce SimValue to number */
function toNum(v: SimValue | undefined): number {
  if (v === undefined) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

/** Static truthiness check used by built-in functions */
function isTruthyStatic(v: SimValue | undefined): boolean {
  if (v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > 0;
  if (typeof v === 'number') return !isNaN(v) && v !== 0;
  return false;
}

const BUILTINS = buildBuiltins();

// ────────────────────────────────────────────────────────────────────────────
// Interpreter
// ────────────────────────────────────────────────────────────────────────────

export class StInterpreter {
  private readonly varBlocks: VarBlockNode[];
  private readonly body: Statement[];

  /** Runtime variable store – keys are always lowercase */
  private variables: Map<string, SimValue> = new Map();

  /** Metadata per variable (keyed lowercase) */
  private meta: Map<string, VarMeta> = new Map();

  constructor(node: ASTNode) {
    switch (node.kind) {
      case 'program':
        this.varBlocks = (node as ProgramNode).varBlocks;
        this.body = (node as ProgramNode).body;
        break;
      case 'functionBlock':
        this.varBlocks = (node as FunctionBlockNode).varBlocks;
        this.body = (node as FunctionBlockNode).body;
        break;
      case 'function':
        this.varBlocks = (node as FunctionNode).varBlocks;
        this.body = (node as FunctionNode).body;
        break;
      default:
        // InterfaceNode and TypeDeclarationNode are not executable
        this.varBlocks = [];
        this.body = [];
        break;
    }

    this.initVariables();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Set a variable value by name (case-insensitive). */
  setVariable(name: string, value: SimValue): void {
    this.variables.set(name.toLowerCase(), value);
  }

  /** Get a variable value by name (case-insensitive). */
  getVariable(name: string): SimValue | undefined {
    return this.variables.get(name.toLowerCase());
  }

  /** Return structured info for every declared variable. */
  getVariableInfo(): VariableInfo[] {
    const result: VariableInfo[] = [];
    for (const [key, value] of this.variables) {
      const m = this.meta.get(key);
      if (m) {
        result.push({
          name: m.originalName,
          scope: m.scope,
          dataType: m.dataType,
          value,
        });
      }
    }
    return result;
  }

  /** Return a copy of the full variable map. */
  getAllVariables(): Map<string, SimValue> {
    return new Map(this.variables);
  }

  /** Execute one PLC scan cycle (all body statements once). */
  runCycle(): void {
    this.executeStatements(this.body);
  }

  /** Re-initialize all variables to their declared defaults. */
  reset(): void {
    this.variables.clear();
    this.meta.clear();
    this.initVariables();
  }

  // ── Variable initialization ─────────────────────────────────────────────

  private initVariables(): void {
    for (const block of this.varBlocks) {
      for (const decl of block.declarations) {
        const dataType = this.typeNodeToString(decl.type);
        const defaultVal = decl.initialValue !== undefined
          ? this.evaluateExpression(decl.initialValue)
          : this.defaultForType(decl.type);

        for (const name of decl.names) {
          const key = name.toLowerCase();
          this.variables.set(key, defaultVal);
          this.meta.set(key, {
            originalName: name,
            scope: block.blockType,
            dataType,
            defaultValue: defaultVal,
          });
        }

        // If the type is an array, initialize individual elements
        if (decl.type.kind === 'arrayType') {
          this.initArrayElements(decl, block.blockType);
        }

        // If the type is a struct, initialize individual members
        if (decl.type.kind === 'structType') {
          this.initStructMembers(decl, block.blockType);
        }
      }
    }
  }

  private initArrayElements(decl: VarDeclarationNode, scope: VarBlockKind): void {
    if (decl.type.kind !== 'arrayType') return;
    const arrType = decl.type;
    const elemDefault = this.defaultForType(arrType.elementType);

    for (const name of decl.names) {
      // Only handle single-dimension arrays for flat key strategy
      for (const dim of arrType.dimensions) {
        const lower = toNum(this.evaluateExpression(dim.lower));
        const upper = toNum(this.evaluateExpression(dim.upper));
        for (let i = lower; i <= upper; i++) {
          const key = `${name.toLowerCase()}_${i}`;
          if (!this.variables.has(key)) {
            this.variables.set(key, elemDefault);
            this.meta.set(key, {
              originalName: `${name}[${i}]`,
              scope,
              dataType: this.typeNodeToString(arrType.elementType),
              defaultValue: elemDefault,
            });
          }
        }
      }
    }
  }

  private initStructMembers(decl: VarDeclarationNode, scope: VarBlockKind): void {
    if (decl.type.kind !== 'structType') return;
    const structType = decl.type;

    for (const varName of decl.names) {
      for (const member of structType.members) {
        const memberDefault = member.initialValue !== undefined
          ? this.evaluateExpression(member.initialValue)
          : this.defaultForType(member.type);
        const key = `${varName.toLowerCase()}_${member.name.toLowerCase()}`;
        if (!this.variables.has(key)) {
          this.variables.set(key, memberDefault);
          this.meta.set(key, {
            originalName: `${varName}.${member.name}`,
            scope,
            dataType: this.typeNodeToString(member.type),
            defaultValue: memberDefault,
          });
        }
      }
    }
  }

  private typeNodeToString(t: TypeNode): string {
    switch (t.kind) {
      case 'elementaryType':
        return t.name;
      case 'arrayType':
        return `ARRAY OF ${this.typeNodeToString(t.elementType)}`;
      case 'stringType':
        return t.baseType;
      case 'structType':
        return 'STRUCT';
      case 'enumType':
        return 'ENUM';
      case 'namedType':
        return t.name;
      case 'subrangeType':
        return this.typeNodeToString(t.baseType);
      default:
        return 'UNKNOWN';
    }
  }

  private defaultForType(t: TypeNode): SimValue {
    switch (t.kind) {
      case 'elementaryType': {
        const upper = t.name.toUpperCase();
        if (upper === 'BOOL') return false;
        if (upper === 'STRING' || upper === 'WSTRING') return '';
        // INT, DINT, SINT, USINT, UINT, UDINT, LINT, ULINT, REAL, LREAL, BYTE, WORD, DWORD, LWORD, TIME, DATE, etc.
        return 0;
      }
      case 'stringType':
        return '';
      case 'arrayType':
        return 0; // The array variable itself; individual elements are initialized separately
      case 'structType':
        return 0; // The struct variable itself; individual members are initialized separately
      case 'enumType':
        return 0;
      case 'namedType':
        return 0;
      case 'subrangeType':
        return 0;
      default:
        return 0;
    }
  }

  // ── Statement execution ─────────────────────────────────────────────────

  /**
   * Execute a list of statements. Returns a ControlSignal if RETURN or EXIT
   * is encountered, otherwise undefined.
   */
  private executeStatements(stmts: Statement[]): ControlSignal | undefined {
    for (const stmt of stmts) {
      const signal = this.executeStatement(stmt);
      if (signal !== undefined) return signal;
    }
    return undefined;
  }

  private executeStatement(stmt: Statement): ControlSignal | undefined {
    switch (stmt.kind) {
      case 'assignment':
        return this.execAssignment(stmt);
      case 'ifStatement':
        return this.execIf(stmt);
      case 'caseStatement':
        return this.execCase(stmt);
      case 'forStatement':
        return this.execFor(stmt);
      case 'whileStatement':
        return this.execWhile(stmt);
      case 'repeatStatement':
        return this.execRepeat(stmt);
      case 'returnStatement':
        return RETURN_SIGNAL;
      case 'exitStatement':
        return EXIT_SIGNAL;
      case 'expressionStatement':
        this.evaluateExpression(stmt.expression);
        return undefined;
      case 'emptyStatement':
        return undefined;
      default:
        return undefined;
    }
  }

  private execAssignment(stmt: { target: Expression; value: Expression }): undefined {
    const value = this.evaluateExpression(stmt.value);
    const key = this.resolveAssignmentTarget(stmt.target);
    this.variables.set(key, value);
    return undefined;
  }

  /**
   * Resolve an assignment target expression to a flat variable key (lowercase).
   */
  private resolveAssignmentTarget(expr: Expression): string {
    switch (expr.kind) {
      case 'identifier':
        return expr.name.toLowerCase();
      case 'memberAccess': {
        const objKey = this.resolveAssignmentTarget(expr.object);
        return `${objKey}_${expr.member.toLowerCase()}`;
      }
      case 'arrayAccess': {
        const arrKey = this.resolveAssignmentTarget(expr.array);
        const index = toNum(this.evaluateExpression(expr.indices[0]));
        return `${arrKey}_${index}`;
      }
      default:
        // Fallback: evaluate and return as string key
        return String(this.evaluateExpression(expr)).toLowerCase();
    }
  }

  private execIf(stmt: {
    condition: Expression;
    thenBody: Statement[];
    elsifBranches: { condition: Expression; body: Statement[] }[];
    elseBody?: Statement[];
  }): ControlSignal | undefined {
    if (this.isTruthy(this.evaluateExpression(stmt.condition))) {
      return this.executeStatements(stmt.thenBody);
    }

    for (const branch of stmt.elsifBranches) {
      if (this.isTruthy(this.evaluateExpression(branch.condition))) {
        return this.executeStatements(branch.body);
      }
    }

    if (stmt.elseBody) {
      return this.executeStatements(stmt.elseBody);
    }

    return undefined;
  }

  private execCase(stmt: {
    expression: Expression;
    cases: { labels: CaseLabel[]; body: Statement[] }[];
    elseBody?: Statement[];
  }): ControlSignal | undefined {
    const val = this.evaluateExpression(stmt.expression);
    const numVal = toNum(val);

    for (const branch of stmt.cases) {
      if (this.matchesCaseLabels(numVal, branch.labels)) {
        return this.executeStatements(branch.body);
      }
    }

    if (stmt.elseBody) {
      return this.executeStatements(stmt.elseBody);
    }

    return undefined;
  }

  private matchesCaseLabels(val: number, labels: CaseLabel[]): boolean {
    for (const label of labels) {
      if (label.kind === 'single') {
        const labelVal = toNum(this.evaluateExpression(label.value));
        if (val === labelVal) return true;
      } else {
        // range
        const lower = toNum(this.evaluateExpression(label.lower));
        const upper = toNum(this.evaluateExpression(label.upper));
        if (val >= lower && val <= upper) return true;
      }
    }
    return false;
  }

  private execFor(stmt: {
    variable: string;
    from: Expression;
    to: Expression;
    by?: Expression;
    body: Statement[];
  }): ControlSignal | undefined {
    const varKey = stmt.variable.toLowerCase();
    const fromVal = toNum(this.evaluateExpression(stmt.from));
    const toVal = toNum(this.evaluateExpression(stmt.to));
    const byVal = stmt.by !== undefined ? toNum(this.evaluateExpression(stmt.by)) : 1;

    // BY = 0 would cause infinite loop; skip entirely
    if (byVal === 0) return undefined;

    this.variables.set(varKey, fromVal);

    let iterations = 0;

    while (iterations < MAX_ITERATIONS) {
      const current = toNum(this.variables.get(varKey));

      // Check termination
      if (byVal > 0 && current > toVal) break;
      if (byVal < 0 && current < toVal) break;

      const signal = this.executeStatements(stmt.body);
      if (signal === RETURN_SIGNAL) return RETURN_SIGNAL;
      if (signal === EXIT_SIGNAL) break; // EXIT breaks innermost loop

      // Increment
      this.variables.set(varKey, toNum(this.variables.get(varKey)) + byVal);
      iterations++;
    }

    return undefined;
  }

  private execWhile(stmt: {
    condition: Expression;
    body: Statement[];
  }): ControlSignal | undefined {
    let iterations = 0;

    while (iterations < MAX_ITERATIONS) {
      if (!this.isTruthy(this.evaluateExpression(stmt.condition))) break;

      const signal = this.executeStatements(stmt.body);
      if (signal === RETURN_SIGNAL) return RETURN_SIGNAL;
      if (signal === EXIT_SIGNAL) break;

      iterations++;
    }

    return undefined;
  }

  private execRepeat(stmt: {
    body: Statement[];
    condition: Expression;
  }): ControlSignal | undefined {
    let iterations = 0;

    while (iterations < MAX_ITERATIONS) {
      const signal = this.executeStatements(stmt.body);
      if (signal === RETURN_SIGNAL) return RETURN_SIGNAL;
      if (signal === EXIT_SIGNAL) break;

      // REPEAT ... UNTIL condition — exits when condition is TRUE
      if (this.isTruthy(this.evaluateExpression(stmt.condition))) break;

      iterations++;
    }

    return undefined;
  }

  // ── Expression evaluation ───────────────────────────────────────────────

  private evaluateExpression(expr: Expression): SimValue {
    switch (expr.kind) {
      case 'integerLiteral':
        return expr.value;
      case 'realLiteral':
        return expr.value;
      case 'stringLiteral':
        return expr.value;
      case 'booleanLiteral':
        return expr.value;
      case 'hexLiteral':
        return expr.value;
      case 'octalLiteral':
        return expr.value;
      case 'binaryLiteral':
        return expr.value;
      case 'timeLiteral':
        return 0; // TIME literals → numeric 0 (ms-based representation not implemented)
      case 'dateLiteral':
        return 0; // DATE literals → numeric 0
      case 'identifier':
        return this.evalIdentifier(expr.name);
      case 'binaryExpression':
        return this.evalBinary(expr.operator, expr.left, expr.right);
      case 'unaryExpression':
        return this.evalUnary(expr.operator, expr.operand);
      case 'functionCall':
        return this.evalFunctionCall(expr.name, expr.args, expr.namedArgs);
      case 'arrayAccess':
        return this.evalArrayAccess(expr.array, expr.indices);
      case 'memberAccess':
        return this.evalMemberAccess(expr.object, expr.member);
      case 'deref':
        // Pointer dereference not supported in simulation; evaluate inner
        return this.evaluateExpression(expr.operand);
      case 'parenthesized':
        return this.evaluateExpression(expr.expression);
      default:
        return 0;
    }
  }

  private evalIdentifier(name: string): SimValue {
    const key = name.toLowerCase();
    const val = this.variables.get(key);
    if (val !== undefined) return val;
    // Unknown identifier → 0 (could be an undeclared enum value, etc.)
    return 0;
  }

  private evalBinary(op: BinaryOperator, leftExpr: Expression, rightExpr: Expression): SimValue {
    const left = this.evaluateExpression(leftExpr);
    const right = this.evaluateExpression(rightExpr);

    // String concatenation with +
    if (op === '+' && (typeof left === 'string' || typeof right === 'string')) {
      return String(left) + String(right);
    }

    const l = toNum(left);
    const r = toNum(right);

    switch (op) {
      // Arithmetic
      case '+': return l + r;
      case '-': return l - r;
      case '*': return l * r;
      case '/':
        // IEEE 754 uyumu: sıfıra bölme Infinity/-Infinity döner, 0/0 ise 0 döner
        // IEEE 754 compliance: division by zero returns Infinity/-Infinity, 0/0 returns 0
        if (r === 0) {
          if (l === 0) return 0;        // 0/0 → 0 (indeterminate, return 0 for PLC safety)
          return l > 0 ? Infinity : -Infinity;
        }
        return l / r;
      case 'MOD':
        if (r === 0) return 0; // Mod by zero → 0
        return l % r;
      case '**': return Math.pow(l, r);

      // Comparison (return boolean)
      case '=': return l === r;
      case '<>': return l !== r;
      case '<': return l < r;
      case '>': return l > r;
      case '<=': return l <= r;
      case '>=': return l >= r;

      // Boolean
      case 'AND': return this.isTruthy(left) && this.isTruthy(right);
      case 'OR': return this.isTruthy(left) || this.isTruthy(right);
      case 'XOR': return this.isTruthy(left) !== this.isTruthy(right);

      // Bitwise shift/rotate (operate on integer values)
      case 'SHL': return (Math.trunc(l) << Math.trunc(r));
      case 'SHR': return (Math.trunc(l) >>> Math.trunc(r));
      case 'ROL': {
        const bits = 32;
        const shift = Math.trunc(r) % bits;
        const v = Math.trunc(l);
        return ((v << shift) | (v >>> (bits - shift))) | 0;
      }
      case 'ROR': {
        const bits = 32;
        const shift = Math.trunc(r) % bits;
        const v = Math.trunc(l);
        return ((v >>> shift) | (v << (bits - shift))) | 0;
      }

      default:
        return 0;
    }
  }

  private evalUnary(op: UnaryOperator, operandExpr: Expression): SimValue {
    const operand = this.evaluateExpression(operandExpr);

    switch (op) {
      case 'NOT':
        return !this.isTruthy(operand);
      case '-':
        return -toNum(operand);
      case '+':
        return toNum(operand);
      default:
        return operand;
    }
  }

  private evalFunctionCall(
    name: string,
    args: Expression[],
    namedArgs: { name: string; value: Expression; assignType: 'input' | 'output' }[],
  ): SimValue {
    const fnKey = name.toLowerCase();

    // Evaluate positional args
    const evaluatedArgs: SimValue[] = args.map((a) => this.evaluateExpression(a));

    // Also collect named input args as positional (for built-in dispatch)
    for (const na of namedArgs) {
      if (na.assignType === 'input') {
        evaluatedArgs.push(this.evaluateExpression(na.value));
      }
    }

    // Look up built-in
    const builtin = BUILTINS.get(fnKey);
    if (builtin) {
      return builtin(evaluatedArgs);
    }

    // Bilinmeyen fonksiyon uyarısı — "Unknown function" büyük harfle başlamalı (test beklentisi)
    // Unknown function warning — must start with capital "Unknown function" to match test expectations
    console.warn(`ST Interpreter: Unknown function '${name}', returning 0`);
    return 0;
  }

  private evalArrayAccess(arrayExpr: Expression, indices: Expression[]): SimValue {
    const arrKey = this.resolveAssignmentTarget(arrayExpr);
    const index = toNum(this.evaluateExpression(indices[0]));
    const flatKey = `${arrKey}_${index}`;
    return this.variables.get(flatKey) ?? 0;
  }

  private evalMemberAccess(objectExpr: Expression, member: string): SimValue {
    const objKey = this.resolveAssignmentTarget(objectExpr);
    const flatKey = `${objKey}_${member.toLowerCase()}`;
    return this.variables.get(flatKey) ?? 0;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Truthiness check that handles NaN correctly.
   * - boolean → value itself
   * - string → non-empty
   * - number → not zero AND not NaN
   */
  private isTruthy(value: SimValue): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.length > 0;
    if (typeof value === 'number') return !isNaN(value) && value !== 0;
    return false;
  }
}
