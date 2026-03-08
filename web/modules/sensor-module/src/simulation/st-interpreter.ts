/**
 * IEC 61131-3 Structured Text Interpreter Engine
 *
 * Tree-walker interpreter that executes a parsed ST AST.
 * Each `runCycle()` call executes all body statements once — equivalent to one PLC scan cycle.
 * Variable state is preserved between cycles.
 */

import type {
  ASTNode,
  ProgramNode,
  FunctionBlockNode,
  FunctionNode,
  VarBlockNode,
  VarBlockKind,
  Statement,
  Expression,
  TypeNode,
  VarDeclarationNode,
  BinaryOperator,
  UnaryOperator,
  IfStatement,
  CaseStatement,
  ForStatement,
  WhileStatement,
  RepeatStatement,
  CaseLabel,
  ElsifBranch,
} from './st-ast-types';

// ── Public Types ─────────────────────────────────────────

export type SimValue = boolean | number | string;

export interface VariableInfo {
  name: string;
  scope: VarBlockKind;
  dataType: string;
  value: SimValue;
}

// ── Signal types for flow control ────────────────────────

type FlowSignal = 'normal' | 'return' | 'exit';

// ── Interpreter ──────────────────────────────────────────

const MAX_ITERATIONS = 100_000;

export class StInterpreter {
  private variables: Map<string, SimValue> = new Map();
  private varMeta: Map<string, { scope: VarBlockKind; dataType: string }> = new Map();
  private initialValues: Map<string, SimValue> = new Map();
  private body: Statement[];
  private varBlocks: VarBlockNode[];

  constructor(node: ASTNode) {
    const pou = node as ProgramNode | FunctionBlockNode | FunctionNode;
    this.varBlocks = pou.varBlocks ?? [];
    this.body = pou.body ?? [];
    this.initVariables(this.varBlocks);
  }

  // ── Public API ───────────────────────────────────────────

  /** Set a variable value (typically used for VAR_INPUT before runCycle) */
  setVariable(name: string, value: SimValue): void {
    // Case-insensitive lookup for the canonical name
    const canonical = this.findCanonicalName(name);
    this.variables.set(canonical, value);
  }

  /** Get a variable's current value */
  getVariable(name: string): SimValue | undefined {
    const canonical = this.findCanonicalName(name);
    return this.variables.get(canonical);
  }

  /** Get metadata + current value for all variables */
  getVariableInfo(): VariableInfo[] {
    const result: VariableInfo[] = [];
    for (const [name, meta] of this.varMeta) {
      result.push({
        name,
        scope: meta.scope,
        dataType: meta.dataType,
        value: this.variables.get(name) ?? this.getDefaultForType(meta.dataType),
      });
    }
    return result;
  }

  /** Get all variables as a Map */
  getAllVariables(): Map<string, SimValue> {
    return new Map(this.variables);
  }

  /** Execute all body statements once (one PLC scan cycle) */
  runCycle(): void {
    this.executeStatements(this.body);
  }

  /** Re-initialize all variables to their declared default values */
  reset(): void {
    this.variables.clear();
    for (const [name, val] of this.initialValues) {
      this.variables.set(name, val);
    }
  }

  // ── Variable Initialization ──────────────────────────────

  private initVariables(varBlocks: VarBlockNode[]): void {
    for (const block of varBlocks) {
      for (const decl of block.declarations) {
        const dataType = this.resolveTypeName(decl.type);
        const defaultVal = decl.initialValue
          ? this.evaluateExpression(decl.initialValue)
          : this.getDefaultValue(decl.type);

        for (const name of decl.names) {
          this.variables.set(name, defaultVal);
          this.initialValues.set(name, defaultVal);
          this.varMeta.set(name, {
            scope: block.blockType,
            dataType,
          });
        }
      }
    }
  }

  private resolveTypeName(type: TypeNode): string {
    switch (type.kind) {
      case 'elementaryType':
        return type.name;
      case 'stringType':
        return type.baseType;
      case 'arrayType':
        return `ARRAY OF ${this.resolveTypeName(type.elementType)}`;
      case 'namedType':
        return type.name;
      case 'enumType':
        return 'ENUM';
      case 'structType':
        return 'STRUCT';
      case 'subrangeType':
        return this.resolveTypeName(type.baseType);
      default:
        return 'UNKNOWN';
    }
  }

  private getDefaultValue(type: TypeNode): SimValue {
    switch (type.kind) {
      case 'elementaryType':
        return this.getDefaultForType(type.name);
      case 'stringType':
        return '';
      case 'arrayType':
        return 0;
      case 'namedType':
        return 0;
      case 'enumType':
        return 0;
      case 'structType':
        return 0;
      case 'subrangeType':
        return 0;
      default:
        return 0;
    }
  }

  private getDefaultForType(typeName: string): SimValue {
    const upper = typeName.toUpperCase();
    if (upper === 'BOOL') return false;
    if (upper === 'STRING' || upper === 'WSTRING') return '';
    // INT, REAL, DINT, SINT, UINT, UDINT, LINT, ULINT, LREAL, BYTE, WORD, DWORD, LWORD, TIME
    return 0;
  }

  // ── Statement Execution ──────────────────────────────────

  private executeStatements(stmts: Statement[]): FlowSignal {
    for (const stmt of stmts) {
      const signal = this.executeStatement(stmt);
      if (signal !== 'normal') {
        return signal;
      }
    }
    return 'normal';
  }

  private executeStatement(stmt: Statement): FlowSignal {
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
        return 'return';
      case 'exitStatement':
        return 'exit';
      case 'expressionStatement':
        this.evaluateExpression(stmt.expression);
        return 'normal';
      case 'emptyStatement':
        return 'normal';
      default:
        return 'normal';
    }
  }

  private execAssignment(stmt: { target: Expression; value: Expression }): FlowSignal {
    const value = this.evaluateExpression(stmt.value);
    this.assignToTarget(stmt.target, value);
    return 'normal';
  }

  private execIf(stmt: IfStatement): FlowSignal {
    if (this.isTruthy(this.evaluateExpression(stmt.condition))) {
      return this.executeStatements(stmt.thenBody);
    }

    if (stmt.elsifBranches) {
      for (const elsif of stmt.elsifBranches) {
        if (this.isTruthy(this.evaluateExpression(elsif.condition))) {
          return this.executeStatements(elsif.body);
        }
      }
    }

    if (stmt.elseBody) {
      return this.executeStatements(stmt.elseBody);
    }

    return 'normal';
  }

  private execCase(stmt: CaseStatement): FlowSignal {
    const value = this.evaluateExpression(stmt.expression);

    for (const branch of stmt.cases) {
      if (this.matchesCaseLabels(value, branch.labels)) {
        return this.executeStatements(branch.body);
      }
    }

    if (stmt.elseBody) {
      return this.executeStatements(stmt.elseBody);
    }

    return 'normal';
  }

  private matchesCaseLabels(value: SimValue, labels: CaseLabel[]): boolean {
    for (const label of labels) {
      if (label.kind === 'single') {
        const labelVal = this.evaluateExpression(label.value);
        if (value === labelVal) return true;
      } else if (label.kind === 'range') {
        const lower = this.evaluateExpression(label.lower);
        const upper = this.evaluateExpression(label.upper);
        if (typeof value === 'number' && typeof lower === 'number' && typeof upper === 'number') {
          if (value >= lower && value <= upper) return true;
        }
      }
    }
    return false;
  }

  private execFor(stmt: ForStatement): FlowSignal {
    const fromVal = this.toNumber(this.evaluateExpression(stmt.from));
    const toVal = this.toNumber(this.evaluateExpression(stmt.to));
    const byVal = stmt.by ? this.toNumber(this.evaluateExpression(stmt.by)) : 1;

    if (byVal === 0) {
      // Avoid infinite loop with zero step
      return 'normal';
    }

    let iterations = 0;
    this.variables.set(stmt.variable, fromVal);

    // Determine loop direction
    const goingUp = byVal > 0;

    while (iterations < MAX_ITERATIONS) {
      const current = this.toNumber(this.variables.get(stmt.variable) ?? 0);

      // Check termination condition based on direction
      if (goingUp && current > toVal) break;
      if (!goingUp && current < toVal) break;

      const signal = this.executeStatements(stmt.body);
      if (signal === 'return') return 'return';
      if (signal === 'exit') break;

      // Increment
      this.variables.set(stmt.variable, current + byVal);
      iterations++;
    }

    return 'normal';
  }

  private execWhile(stmt: WhileStatement): FlowSignal {
    let iterations = 0;

    while (iterations < MAX_ITERATIONS) {
      if (!this.isTruthy(this.evaluateExpression(stmt.condition))) break;

      const signal = this.executeStatements(stmt.body);
      if (signal === 'return') return 'return';
      if (signal === 'exit') break;

      iterations++;
    }

    return 'normal';
  }

  private execRepeat(stmt: RepeatStatement): FlowSignal {
    let iterations = 0;

    while (iterations < MAX_ITERATIONS) {
      const signal = this.executeStatements(stmt.body);
      if (signal === 'return') return 'return';
      if (signal === 'exit') break;

      // REPEAT...UNTIL: exit when condition becomes TRUE
      if (this.isTruthy(this.evaluateExpression(stmt.condition))) break;

      iterations++;
    }

    return 'normal';
  }

  // ── Expression Evaluation ────────────────────────────────

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

      case 'timeLiteral':
        // Parse time literal to milliseconds as number
        return this.parseTimeLiteral(expr.raw);

      case 'identifier':
        return this.variables.get(expr.name) ?? this.variables.get(expr.name.toUpperCase()) ?? this.variables.get(expr.name.toLowerCase()) ?? 0;

      case 'binaryExpression':
        return this.evalBinary(expr.operator, expr.left, expr.right);

      case 'unaryExpression':
        return this.evalUnary(expr.operator, expr.operand);

      case 'functionCall':
        return this.evalFunctionCall(expr.name, expr.args);

      case 'memberAccess':
        return this.evalMemberAccess(expr.object, expr.member);

      case 'arrayAccess':
        return this.evalArrayAccess(expr.array, expr.indices);

      case 'parenthesized':
        return this.evaluateExpression(expr.expression);

      case 'hexLiteral':
        return expr.value;

      case 'octalLiteral':
        return expr.value;

      case 'binaryLiteral':
        return expr.value;

      case 'dateLiteral':
        return 0; // Date literals are not used in simulation

      case 'deref':
        // Pointer dereference — not supported in simulation, evaluate operand
        return this.evaluateExpression(expr.operand);

      default:
        return 0;
    }
  }

  private evalBinary(op: BinaryOperator, left: Expression, right: Expression): SimValue {
    const lVal = this.evaluateExpression(left);
    const rVal = this.evaluateExpression(right);

    switch (op) {
      // Arithmetic
      case '+':
        if (typeof lVal === 'string' || typeof rVal === 'string') {
          return String(lVal) + String(rVal);
        }
        return this.toNumber(lVal) + this.toNumber(rVal);
      case '-':
        return this.toNumber(lVal) - this.toNumber(rVal);
      case '*':
        return this.toNumber(lVal) * this.toNumber(rVal);
      case '/': {
        const divisor = this.toNumber(rVal);
        if (divisor === 0) {
          // Division by zero: return Infinity (don't crash)
          const dividend = this.toNumber(lVal);
          if (dividend === 0) return 0; // 0/0 = 0 (NaN avoidance)
          return dividend > 0 ? Infinity : -Infinity;
        }
        return this.toNumber(lVal) / divisor;
      }
      case 'MOD': {
        const divisor = this.toNumber(rVal);
        if (divisor === 0) return 0;
        return this.toNumber(lVal) % divisor;
      }
      case '**':
        return Math.pow(this.toNumber(lVal), this.toNumber(rVal));

      // Comparison
      case '=':
        return lVal === rVal;
      case '<>':
        return lVal !== rVal;
      case '<':
        return this.toNumber(lVal) < this.toNumber(rVal);
      case '>':
        return this.toNumber(lVal) > this.toNumber(rVal);
      case '<=':
        return this.toNumber(lVal) <= this.toNumber(rVal);
      case '>=':
        return this.toNumber(lVal) >= this.toNumber(rVal);

      // Boolean / Bitwise
      case 'AND':
        if (typeof lVal === 'boolean' && typeof rVal === 'boolean') {
          return lVal && rVal;
        }
        // Bitwise AND for integers
        return (this.toNumber(lVal) | 0) & (this.toNumber(rVal) | 0);
      case 'OR':
        if (typeof lVal === 'boolean' && typeof rVal === 'boolean') {
          return lVal || rVal;
        }
        // Bitwise OR for integers
        return (this.toNumber(lVal) | 0) | (this.toNumber(rVal) | 0);
      case 'XOR':
        if (typeof lVal === 'boolean' && typeof rVal === 'boolean') {
          return lVal !== rVal;
        }
        // Bitwise XOR for integers
        return (this.toNumber(lVal) | 0) ^ (this.toNumber(rVal) | 0);

      // Bitwise shift / rotate
      case 'SHL':
        return (this.toNumber(lVal) | 0) << (this.toNumber(rVal) | 0);
      case 'SHR':
        return (this.toNumber(lVal) | 0) >>> (this.toNumber(rVal) | 0);
      case 'ROL': {
        const v = this.toNumber(lVal) | 0;
        const n = (this.toNumber(rVal) | 0) % 32;
        return (v << n) | (v >>> (32 - n));
      }
      case 'ROR': {
        const v = this.toNumber(lVal) | 0;
        const n = (this.toNumber(rVal) | 0) % 32;
        return (v >>> n) | (v << (32 - n));
      }

      default:
        return 0;
    }
  }

  private evalUnary(op: UnaryOperator, operand: Expression): SimValue {
    const val = this.evaluateExpression(operand);
    switch (op) {
      case 'NOT':
        if (typeof val === 'boolean') return !val;
        // Bitwise NOT for integers
        return ~(this.toNumber(val) | 0);
      case '-':
        return -this.toNumber(val);
      case '+':
        return +this.toNumber(val);
      default:
        return val;
    }
  }

  private evalFunctionCall(name: string, args: Expression[]): SimValue {
    const evaluatedArgs = args.map(a => this.evaluateExpression(a));
    return this.callBuiltinFunction(name.toUpperCase(), evaluatedArgs);
  }

  private evalMemberAccess(object: Expression, member: string): SimValue {
    // Flat lookup: obj.field → obj_field
    if (object.kind === 'identifier') {
      const flatKey = `${object.name}_${member}`;
      return this.variables.get(flatKey) ?? 0;
    }
    // Nested: obj.inner.field → obj_inner_field
    if (object.kind === 'memberAccess') {
      const parentVal = this.buildMemberPath(object);
      const flatKey = `${parentVal}_${member}`;
      return this.variables.get(flatKey) ?? 0;
    }
    return 0;
  }

  private buildMemberPath(expr: Expression): string {
    if (expr.kind === 'identifier') {
      return expr.name;
    }
    if (expr.kind === 'memberAccess') {
      return `${this.buildMemberPath(expr.object)}_${expr.member}`;
    }
    return '';
  }

  private evalArrayAccess(array: Expression, indices: Expression[]): SimValue {
    // Flat key: arr_0, arr_1, arr_0_1 etc.
    const baseName = array.kind === 'identifier' ? array.name : this.buildMemberPath(array);
    const indexParts = indices.map(i => String(this.toNumber(this.evaluateExpression(i))));
    const flatKey = `${baseName}_${indexParts.join('_')}`;
    return this.variables.get(flatKey) ?? 0;
  }

  // ── Target Assignment ────────────────────────────────────

  private assignToTarget(target: Expression, value: SimValue): void {
    if (target.kind === 'identifier') {
      const canonical = this.findCanonicalName(target.name);
      this.variables.set(canonical, value);
    } else if (target.kind === 'memberAccess') {
      const flatKey = `${this.buildMemberPath(target.object)}_${target.member}`;
      this.variables.set(flatKey, value);
    } else if (target.kind === 'arrayAccess') {
      const baseName = target.array.kind === 'identifier' ? target.array.name : this.buildMemberPath(target.array);
      const indexParts = target.indices.map(i => String(this.toNumber(this.evaluateExpression(i))));
      const flatKey = `${baseName}_${indexParts.join('_')}`;
      this.variables.set(flatKey, value);
    }
  }

  // ── Built-in Functions ───────────────────────────────────

  private callBuiltinFunction(name: string, args: SimValue[]): SimValue {
    switch (name) {
      // Math
      case 'ABS':
        return Math.abs(this.toNumber(args[0] ?? 0));
      case 'SQRT':
        return Math.sqrt(this.toNumber(args[0] ?? 0));
      case 'SIN':
        return Math.sin(this.toNumber(args[0] ?? 0));
      case 'COS':
        return Math.cos(this.toNumber(args[0] ?? 0));
      case 'TAN':
        return Math.tan(this.toNumber(args[0] ?? 0));
      case 'ASIN':
        return Math.asin(this.toNumber(args[0] ?? 0));
      case 'ACOS':
        return Math.acos(this.toNumber(args[0] ?? 0));
      case 'ATAN':
        return Math.atan(this.toNumber(args[0] ?? 0));
      case 'LN':
        return Math.log(this.toNumber(args[0] ?? 0));
      case 'LOG':
        return Math.log10(this.toNumber(args[0] ?? 0));
      case 'EXP':
        return Math.exp(this.toNumber(args[0] ?? 0));
      case 'TRUNC':
        return Math.trunc(this.toNumber(args[0] ?? 0));
      case 'EXPT':
        return Math.pow(this.toNumber(args[0] ?? 0), this.toNumber(args[1] ?? 0));

      // Selection
      case 'MIN':
        return Math.min(this.toNumber(args[0] ?? 0), this.toNumber(args[1] ?? 0));
      case 'MAX':
        return Math.max(this.toNumber(args[0] ?? 0), this.toNumber(args[1] ?? 0));
      case 'LIMIT': {
        // LIMIT(min, val, max)
        const min = this.toNumber(args[0] ?? 0);
        const val = this.toNumber(args[1] ?? 0);
        const max = this.toNumber(args[2] ?? 0);
        return Math.min(Math.max(val, min), max);
      }
      case 'SEL': {
        // SEL(cond, false_val, true_val)
        const cond = this.isTruthy(args[0] ?? false);
        return cond ? (args[2] ?? 0) : (args[1] ?? 0);
      }

      // Type conversion
      case 'INT_TO_REAL':
        return this.toNumber(args[0] ?? 0);
      case 'REAL_TO_INT':
        return Math.trunc(this.toNumber(args[0] ?? 0));
      case 'BOOL_TO_INT':
        return this.isTruthy(args[0] ?? false) ? 1 : 0;
      case 'INT_TO_BOOL':
        return this.toNumber(args[0] ?? 0) !== 0;

      default:
        console.warn(`[StInterpreter] Unknown function: ${name}`);
        return 0;
    }
  }

  // ── Helper Utilities ─────────────────────────────────────

  private isTruthy(value: SimValue): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') return value.length > 0;
    return false;
  }

  private toNumber(value: SimValue | undefined): number {
    if (value === undefined) return 0;
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'string') {
      const n = parseFloat(value);
      return isNaN(n) ? 0 : n;
    }
    return 0;
  }

  private findCanonicalName(name: string): string {
    // Direct match first
    if (this.variables.has(name)) return name;
    // Case-insensitive fallback
    for (const key of this.variables.keys()) {
      if (key.toLowerCase() === name.toLowerCase()) return key;
    }
    return name;
  }

  private parseTimeLiteral(raw: string): number {
    // Basic TIME literal parsing: T#100ms, T#1s, T#1m, T#1h
    const cleaned = raw.replace(/^(T|TIME)#/i, '');
    let ms = 0;
    const hMatch = cleaned.match(/([\d.]+)h/i);
    const mMatch = cleaned.match(/([\d.]+)m(?!s)/i);
    const sMatch = cleaned.match(/([\d.]+)s/i);
    const msMatch = cleaned.match(/([\d.]+)ms/i);

    if (hMatch) ms += parseFloat(hMatch[1]) * 3600000;
    if (mMatch) ms += parseFloat(mMatch[1]) * 60000;
    if (sMatch) ms += parseFloat(sMatch[1]) * 1000;
    if (msMatch) ms += parseFloat(msMatch[1]);

    return ms;
  }
}
