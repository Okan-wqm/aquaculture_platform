/**
 * IEC 61131-3 Structured Text - Semantic Analyzer
 *
 * Walks the AST and produces diagnostics for:
 * 1.  Undefined variable references (STS001)
 * 2.  Type mismatch in assignments (STS002)
 * 3.  Type mismatch in expressions (STS003)
 * 4.  Undefined function/FB calls (STS004)
 * 5.  Wrong number of arguments (STS005)
 * 6.  Wrong argument types (STS006)
 * 7.  Unused variables (STW001)
 * 8.  Write to constant (STS007)
 * 9.  Write to VAR_INPUT (STS008)
 * 10. Missing RETURN in FUNCTION (STW002)
 * 11. Unreachable code after RETURN (STW003)
 * 12. FOR variable must be integer (STS009)
 * 13. CASE expression must match type (STS010)
 * 14. Duplicate variable declaration (STS011)
 * 15. Duplicate POU name (STS012)
 * 16. GOTO usage (STW004)
 * 17. Division by zero (literal) (STW005)
 * 18. Array index out of bounds (literal) (STW006)
 * 19. TIME literal overflow (STW007)
 * 20. Infinite loop detection (simple) (STH001)
 *
 * NOTE: AST types are defined locally because the parser module
 * (../parser/st-ast.ts) does not exist yet. Once the parser is
 * implemented, import AST types from there and remove the local defs.
 */

import { Diagnostic, SourceRange, DiagnosticSeverity } from '../compiler.types';
import {
  SymbolTable,
  Symbol,
  DataType,
  ElementaryType,
  elementary,
  VariableScope,
  FunctionParameter,
  FBParameter,
  FunctionBlockType,
} from './symbol-table';
import { TypeChecker } from './type-checker';

// ────────────────────────────────────────────────────────────────────────────
// Local AST Node Types
// (To be replaced with imports from ../parser/st-ast.ts when available)
// ────────────────────────────────────────────────────────────────────────────

export interface ASTLocation {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

/** Base for all AST nodes */
interface BaseNode {
  loc: ASTLocation;
}

// -- Expressions --

export interface IdentifierExpr extends BaseNode {
  type: 'Identifier';
  name: string;
}

export interface IntegerLiteral extends BaseNode {
  type: 'IntegerLiteral';
  value: number;
}

export interface RealLiteral extends BaseNode {
  type: 'RealLiteral';
  value: number;
}

export interface StringLiteral extends BaseNode {
  type: 'StringLiteral';
  value: string;
}

export interface BooleanLiteral extends BaseNode {
  type: 'BooleanLiteral';
  value: boolean;
}

export interface TimeLiteral extends BaseNode {
  type: 'TimeLiteral';
  value: string;
  /** Total milliseconds */
  totalMs: number;
}

export interface DateLiteral extends BaseNode {
  type: 'DateLiteral';
  value: string;
}

export interface BinaryExpr extends BaseNode {
  type: 'BinaryExpr';
  operator: string;
  left: Expression;
  right: Expression;
}

export interface UnaryExpr extends BaseNode {
  type: 'UnaryExpr';
  operator: string;
  operand: Expression;
}

export interface FunctionCallExpr extends BaseNode {
  type: 'FunctionCall';
  name: string;
  args: Expression[];
  /** Named arguments (FB style) */
  namedArgs?: Array<{ name: string; value: Expression }>;
}

export interface MemberAccessExpr extends BaseNode {
  type: 'MemberAccess';
  object: Expression;
  member: string;
}

export interface ArrayAccessExpr extends BaseNode {
  type: 'ArrayAccess';
  array: Expression;
  index: Expression;
}

export interface ParenExpr extends BaseNode {
  type: 'ParenExpr';
  expr: Expression;
}

export type Expression =
  | IdentifierExpr
  | IntegerLiteral
  | RealLiteral
  | StringLiteral
  | BooleanLiteral
  | TimeLiteral
  | DateLiteral
  | BinaryExpr
  | UnaryExpr
  | FunctionCallExpr
  | MemberAccessExpr
  | ArrayAccessExpr
  | ParenExpr;

// -- Variable Declarations --

export interface VarDeclaration extends BaseNode {
  type: 'VarDeclaration';
  name: string;
  dataType: string;
  /** Parsed array bounds if ARRAY type */
  arrayBounds?: { lower: number; upper: number };
  /** Element type for ARRAY */
  elementType?: string;
  initialValue?: Expression;
  isConstant: boolean;
}

export interface VarBlock extends BaseNode {
  type: 'VarBlock';
  scope: VariableScope;
  isConstant: boolean;
  isRetain: boolean;
  declarations: VarDeclaration[];
}

// -- Statements --

export interface AssignmentStmt extends BaseNode {
  type: 'Assignment';
  target: Expression;
  value: Expression;
}

export interface IfStmt extends BaseNode {
  type: 'IfStatement';
  condition: Expression;
  thenBranch: Statement[];
  elsifBranches?: Array<{ condition: Expression; body: Statement[] }>;
  elseBranch?: Statement[];
}

export interface CaseStmt extends BaseNode {
  type: 'CaseStatement';
  expression: Expression;
  cases: Array<{ values: Expression[]; body: Statement[] }>;
  elseBody?: Statement[];
}

export interface ForStmt extends BaseNode {
  type: 'ForStatement';
  variable: string;
  from: Expression;
  to: Expression;
  by?: Expression;
  body: Statement[];
}

export interface WhileStmt extends BaseNode {
  type: 'WhileStatement';
  condition: Expression;
  body: Statement[];
}

export interface RepeatStmt extends BaseNode {
  type: 'RepeatStatement';
  condition: Expression;
  body: Statement[];
}

export interface ReturnStmt extends BaseNode {
  type: 'ReturnStatement';
  value?: Expression;
}

export interface ExitStmt extends BaseNode {
  type: 'ExitStatement';
}

export interface FunctionCallStmt extends BaseNode {
  type: 'FunctionCallStatement';
  call: FunctionCallExpr;
}

export interface EmptyStmt extends BaseNode {
  type: 'EmptyStatement';
}

export type Statement =
  | AssignmentStmt
  | IfStmt
  | CaseStmt
  | ForStmt
  | WhileStmt
  | RepeatStmt
  | ReturnStmt
  | ExitStmt
  | FunctionCallStmt
  | EmptyStmt;

// -- POU (Program Organization Units) --

export interface ProgramDecl extends BaseNode {
  type: 'Program';
  name: string;
  varBlocks: VarBlock[];
  body: Statement[];
}

export interface FunctionDecl extends BaseNode {
  type: 'Function';
  name: string;
  returnType: string;
  varBlocks: VarBlock[];
  body: Statement[];
}

export interface FunctionBlockDecl extends BaseNode {
  type: 'FunctionBlock';
  name: string;
  varBlocks: VarBlock[];
  body: Statement[];
}

export type POUDecl = ProgramDecl | FunctionDecl | FunctionBlockDecl;
export type ASTNode = POUDecl;

// ────────────────────────────────────────────────────────────────────────────
// Error Codes
// ────────────────────────────────────────────────────────────────────────────

const ErrorCodes = {
  UNDEFINED_VARIABLE:   'STS001',
  TYPE_MISMATCH_ASSIGN: 'STS002',
  TYPE_MISMATCH_EXPR:   'STS003',
  UNDEFINED_FUNCTION:   'STS004',
  WRONG_ARG_COUNT:      'STS005',
  WRONG_ARG_TYPE:       'STS006',
  WRITE_TO_CONSTANT:    'STS007',
  WRITE_TO_INPUT:       'STS008',
  FOR_VAR_NOT_INT:      'STS009',
  CASE_TYPE_MISMATCH:   'STS010',
  DUPLICATE_VAR:        'STS011',
  DUPLICATE_POU:        'STS012',
  UNUSED_VARIABLE:      'STW001',
  MISSING_RETURN:       'STW002',
  UNREACHABLE_CODE:     'STW003',
  GOTO_USAGE:           'STW004',
  DIVISION_BY_ZERO:     'STW005',
  ARRAY_OUT_OF_BOUNDS:  'STW006',
  TIME_OVERFLOW:        'STW007',
  INFINITE_LOOP:        'STH001',
} as const;

// ────────────────────────────────────────────────────────────────────────────
// Semantic Analyzer
// ────────────────────────────────────────────────────────────────────────────

/** Maximum number of diagnostics before we stop */
const MAX_DIAGNOSTICS = 200;

/** Maximum TIME value in ms (49d 17h 2m 47s 295ms per DWORD limit) */
const MAX_TIME_MS = 2 ** 32 - 1;

export class SemanticAnalyzer {
  private diagnostics: Diagnostic[] = [];
  private symbolTable: SymbolTable;
  private typeChecker: TypeChecker;
  private pouNames: Set<string> = new Set();

  constructor() {
    this.symbolTable = new SymbolTable();
    this.typeChecker = new TypeChecker();
  }

  /**
   * Analyze an array of AST nodes (POUs) and return diagnostics.
   */
  analyze(ast: ASTNode[]): Diagnostic[] {
    this.diagnostics = [];
    this.pouNames.clear();

    for (const node of ast) {
      if (this.diagnostics.length >= MAX_DIAGNOSTICS) break;
      this.analyzeNode(node);
    }

    return this.diagnostics;
  }

  /**
   * Get the symbol table (useful for IntelliSense after analysis).
   */
  getSymbolTable(): SymbolTable {
    return this.symbolTable;
  }

  // ── Node dispatch ──────────────────────────────────────────────────────

  private analyzeNode(node: ASTNode): void {
    switch (node.type) {
      case 'Program': return this.analyzeProgram(node);
      case 'Function': return this.analyzeFunction(node);
      case 'FunctionBlock': return this.analyzeFunctionBlock(node);
    }
  }

  // ── POU analysis ───────────────────────────────────────────────────────

  private analyzeProgram(node: ProgramDecl): void {
    // Check #15: duplicate POU name
    this.checkDuplicatePOU(node.name, node.loc);

    this.symbolTable.enterScope(node.name, 'program');

    // Register program in global scope
    this.symbolTable.define({
      name: node.name,
      kind: 'program',
      dataType: { kind: 'unknown' },
      scope: 'VAR',
      location: this.toRange(node.loc),
      isUsed: true,
      isWritten: false,
      isConstant: false,
    });

    this.analyzeVarBlocks(node.varBlocks);
    this.analyzeStatements(node.body);
    this.checkUnusedSymbols();
    this.symbolTable.exitScope();
  }

  private analyzeFunction(node: FunctionDecl): void {
    this.checkDuplicatePOU(node.name, node.loc);

    this.symbolTable.enterScope(node.name, 'function');

    // Register function return variable (IEC convention: function name = return var)
    const returnType = this.resolveTypeName(node.returnType);
    this.symbolTable.define({
      name: node.name,
      kind: 'variable',
      dataType: returnType,
      scope: 'VAR',
      location: this.toRange(node.loc),
      isUsed: true,
      isWritten: false,
      isConstant: false,
    });

    this.analyzeVarBlocks(node.varBlocks);
    this.analyzeStatements(node.body);

    // Check #10: missing RETURN in FUNCTION
    if (!this.bodyHasReturn(node.body)) {
      // Check if the function name variable is assigned (IEC convention)
      const funcSym = this.symbolTable.resolveLocal(node.name);
      if (!funcSym || !funcSym.isWritten) {
        this.addDiagnostic(
          node.loc,
          'warning',
          `Function '${node.name}' may not return a value. Assign to '${node.name}' or use RETURN.`,
          ErrorCodes.MISSING_RETURN,
        );
      }
    }

    this.checkUnusedSymbols();
    this.symbolTable.exitScope();
  }

  private analyzeFunctionBlock(node: FunctionBlockDecl): void {
    this.checkDuplicatePOU(node.name, node.loc);

    this.symbolTable.enterScope(node.name, 'functionBlock');

    this.analyzeVarBlocks(node.varBlocks);
    this.analyzeStatements(node.body);
    this.checkUnusedSymbols();
    this.symbolTable.exitScope();
  }

  // ── Variable blocks ────────────────────────────────────────────────────

  private analyzeVarBlocks(blocks: VarBlock[]): void {
    for (const block of blocks) {
      for (const decl of block.declarations) {
        if (this.diagnostics.length >= MAX_DIAGNOSTICS) return;
        this.analyzeVarDeclaration(decl, block.scope, block.isConstant);
      }
    }
  }

  private analyzeVarDeclaration(decl: VarDeclaration, scope: VariableScope, blockConstant: boolean): void {
    const dataType = this.resolveVarType(decl);
    const isConst = decl.isConstant || blockConstant;

    // Check #14: duplicate variable declaration
    const defined = this.symbolTable.define({
      name: decl.name,
      kind: isConst ? 'constant' : 'variable',
      dataType,
      scope,
      location: this.toRange(decl.loc),
      isUsed: false,
      isWritten: false,
      isConstant: isConst,
    });

    if (!defined) {
      this.addDiagnostic(
        decl.loc,
        'error',
        `Duplicate variable declaration: '${decl.name}'`,
        ErrorCodes.DUPLICATE_VAR,
      );
    }

    // Analyze initializer
    if (decl.initialValue) {
      const initType = this.inferExprType(decl.initialValue);
      if (initType && !this.typeChecker.isAssignableTo(initType, dataType)) {
        this.addDiagnostic(
          decl.loc,
          'error',
          `Type mismatch in initialization: cannot assign ${this.typeChecker.typeToString(initType)} to ${this.typeChecker.typeToString(dataType)}`,
          ErrorCodes.TYPE_MISMATCH_ASSIGN,
        );
      }
    }
  }

  // ── Statement analysis ─────────────────────────────────────────────────

  private analyzeStatements(stmts: Statement[]): void {
    let hasReturn = false;

    for (let i = 0; i < stmts.length; i++) {
      if (this.diagnostics.length >= MAX_DIAGNOSTICS) return;
      const stmt = stmts[i]!;

      // Check #11: unreachable code after RETURN
      if (hasReturn) {
        this.addDiagnostic(
          stmt.loc,
          'warning',
          'Unreachable code after RETURN statement',
          ErrorCodes.UNREACHABLE_CODE,
        );
        break; // stop analyzing unreachable code
      }

      this.analyzeStatement(stmt);

      if (stmt.type === 'ReturnStatement') {
        hasReturn = true;
      }
    }
  }

  private analyzeStatement(stmt: Statement): void {
    switch (stmt.type) {
      case 'Assignment': return this.analyzeAssignment(stmt);
      case 'IfStatement': return this.analyzeIf(stmt);
      case 'CaseStatement': return this.analyzeCase(stmt);
      case 'ForStatement': return this.analyzeFor(stmt);
      case 'WhileStatement': return this.analyzeWhile(stmt);
      case 'RepeatStatement': return this.analyzeRepeat(stmt);
      case 'ReturnStatement': return this.analyzeReturn(stmt);
      case 'ExitStatement': return this.analyzeExit(stmt);
      case 'FunctionCallStatement': return this.analyzeFunctionCallStmt(stmt);
      case 'EmptyStatement': return;
    }
  }

  private analyzeAssignment(stmt: AssignmentStmt): void {
    const targetType = this.inferExprType(stmt.target);
    const valueType = this.inferExprType(stmt.value);

    // Check write target validity
    if (stmt.target.type === 'Identifier') {
      const sym = this.symbolTable.resolve(stmt.target.name);
      if (sym) {
        // Check #8: write to constant
        if (sym.isConstant) {
          this.addDiagnostic(
            stmt.loc,
            'error',
            `Cannot assign to constant '${stmt.target.name}'`,
            ErrorCodes.WRITE_TO_CONSTANT,
          );
        }
        // Check #9: write to VAR_INPUT
        if (sym.scope === 'VAR_INPUT') {
          this.addDiagnostic(
            stmt.loc,
            'error',
            `Cannot assign to VAR_INPUT '${stmt.target.name}'`,
            ErrorCodes.WRITE_TO_INPUT,
          );
        }
        sym.isWritten = true;
      }
    }

    // Check #17: division by zero
    this.checkDivisionByZero(stmt.value);

    // Check #2: type mismatch in assignment
    if (targetType && valueType && !this.typeChecker.isAssignableTo(valueType, targetType)) {
      this.addDiagnostic(
        stmt.loc,
        'error',
        `Type mismatch in assignment: cannot assign ${this.typeChecker.typeToString(valueType)} to ${this.typeChecker.typeToString(targetType)}`,
        ErrorCodes.TYPE_MISMATCH_ASSIGN,
      );
    }
  }

  private analyzeIf(stmt: IfStmt): void {
    const condType = this.inferExprType(stmt.condition);
    this.checkBoolCondition(condType, stmt.condition.loc, 'IF');

    this.analyzeStatements(stmt.thenBranch);

    if (stmt.elsifBranches) {
      for (const elsif of stmt.elsifBranches) {
        const elsifCondType = this.inferExprType(elsif.condition);
        this.checkBoolCondition(elsifCondType, elsif.condition.loc, 'ELSIF');
        this.analyzeStatements(elsif.body);
      }
    }

    if (stmt.elseBranch) {
      this.analyzeStatements(stmt.elseBranch);
    }
  }

  private analyzeCase(stmt: CaseStmt): void {
    const exprType = this.inferExprType(stmt.expression);

    for (const c of stmt.cases) {
      for (const val of c.values) {
        const valType = this.inferExprType(val);
        // Check #13: CASE value must match expression type
        if (exprType && valType && !this.typeChecker.isAssignableTo(valType, exprType)) {
          this.addDiagnostic(
            val.loc,
            'error',
            `CASE value type ${this.typeChecker.typeToString(valType)} does not match CASE expression type ${this.typeChecker.typeToString(exprType)}`,
            ErrorCodes.CASE_TYPE_MISMATCH,
          );
        }
      }
      this.analyzeStatements(c.body);
    }

    if (stmt.elseBody) {
      this.analyzeStatements(stmt.elseBody);
    }
  }

  private analyzeFor(stmt: ForStmt): void {
    // Check #12: FOR variable must be integer
    const varSym = this.symbolTable.resolve(stmt.variable);
    if (varSym) {
      varSym.isUsed = true;
      varSym.isWritten = true;
      if (!this.typeChecker.isIntegerType(varSym.dataType)) {
        this.addDiagnostic(
          stmt.loc,
          'error',
          `FOR loop variable '${stmt.variable}' must be an integer type, got ${this.typeChecker.typeToString(varSym.dataType)}`,
          ErrorCodes.FOR_VAR_NOT_INT,
        );
      }
    } else {
      // Check #1: undefined variable
      this.addDiagnostic(
        stmt.loc,
        'error',
        `Undefined variable '${stmt.variable}'`,
        ErrorCodes.UNDEFINED_VARIABLE,
      );
    }

    this.inferExprType(stmt.from);
    this.inferExprType(stmt.to);
    if (stmt.by) this.inferExprType(stmt.by);

    // Check #20: infinite loop (simple: BY = 0)
    if (stmt.by && stmt.by.type === 'IntegerLiteral' && stmt.by.value === 0) {
      this.addDiagnostic(
        stmt.by.loc,
        'hint',
        'FOR loop with BY = 0 creates an infinite loop',
        ErrorCodes.INFINITE_LOOP,
      );
    }

    this.symbolTable.enterScope('FOR', 'block');
    this.analyzeStatements(stmt.body);
    this.symbolTable.exitScope();
  }

  private analyzeWhile(stmt: WhileStmt): void {
    const condType = this.inferExprType(stmt.condition);
    this.checkBoolCondition(condType, stmt.condition.loc, 'WHILE');

    // Check #20: infinite loop (WHILE TRUE)
    if (stmt.condition.type === 'BooleanLiteral' && stmt.condition.value === true) {
      // Only a hint if there's no EXIT in the body
      if (!this.bodyHasExit(stmt.body)) {
        this.addDiagnostic(
          stmt.condition.loc,
          'hint',
          'WHILE TRUE without EXIT creates an infinite loop',
          ErrorCodes.INFINITE_LOOP,
        );
      }
    }

    this.symbolTable.enterScope('WHILE', 'block');
    this.analyzeStatements(stmt.body);
    this.symbolTable.exitScope();
  }

  private analyzeRepeat(stmt: RepeatStmt): void {
    this.symbolTable.enterScope('REPEAT', 'block');
    this.analyzeStatements(stmt.body);
    this.symbolTable.exitScope();

    const condType = this.inferExprType(stmt.condition);
    this.checkBoolCondition(condType, stmt.condition.loc, 'UNTIL');

    // Check #20: REPEAT ... UNTIL FALSE
    if (stmt.condition.type === 'BooleanLiteral' && stmt.condition.value === false) {
      if (!this.bodyHasExit(stmt.body)) {
        this.addDiagnostic(
          stmt.condition.loc,
          'hint',
          'REPEAT ... UNTIL FALSE without EXIT creates an infinite loop',
          ErrorCodes.INFINITE_LOOP,
        );
      }
    }
  }

  private analyzeReturn(stmt: ReturnStmt): void {
    if (stmt.value) {
      this.inferExprType(stmt.value);
    }
  }

  private analyzeExit(_stmt: ExitStmt): void {
    // EXIT is valid only inside a loop -- checking could be done here
    // but typically the parser enforces this
  }

  private analyzeFunctionCallStmt(stmt: FunctionCallStmt): void {
    this.analyzeFunctionCall(stmt.call);
  }

  // ── Expression analysis & type inference ───────────────────────────────

  /**
   * Infer the type of an expression, also performing semantic checks.
   * Returns null if type cannot be determined.
   */
  private inferExprType(expr: Expression): DataType | null {
    switch (expr.type) {
      case 'Identifier':
        return this.inferIdentifierType(expr);

      case 'IntegerLiteral':
        return elementary('INT');

      case 'RealLiteral':
        return elementary('REAL');

      case 'StringLiteral':
        return elementary('STRING');

      case 'BooleanLiteral':
        return elementary('BOOL');

      case 'TimeLiteral':
        // Check #19: TIME literal overflow
        if (expr.totalMs > MAX_TIME_MS) {
          this.addDiagnostic(
            expr.loc,
            'warning',
            `TIME literal exceeds maximum value (${MAX_TIME_MS}ms)`,
            ErrorCodes.TIME_OVERFLOW,
          );
        }
        return elementary('TIME');

      case 'DateLiteral':
        return elementary('DATE');

      case 'BinaryExpr':
        return this.inferBinaryExprType(expr);

      case 'UnaryExpr':
        return this.inferUnaryExprType(expr);

      case 'FunctionCall':
        return this.analyzeFunctionCall(expr);

      case 'MemberAccess':
        return this.inferMemberAccessType(expr);

      case 'ArrayAccess':
        return this.inferArrayAccessType(expr);

      case 'ParenExpr':
        return this.inferExprType(expr.expr);
    }
  }

  private inferIdentifierType(expr: IdentifierExpr): DataType | null {
    const sym = this.symbolTable.resolve(expr.name);
    if (!sym) {
      // Check #1: undefined variable reference
      this.addDiagnostic(
        expr.loc,
        'error',
        `Undefined variable '${expr.name}'`,
        ErrorCodes.UNDEFINED_VARIABLE,
      );
      return null;
    }
    sym.isUsed = true;
    return sym.dataType;
  }

  private inferBinaryExprType(expr: BinaryExpr): DataType | null {
    const leftType = this.inferExprType(expr.left);
    const rightType = this.inferExprType(expr.right);

    // Check #17: division by zero
    this.checkDivisionByZero(expr);

    if (!leftType || !rightType) return null;

    // Check #3: type mismatch in expression
    const resultType = this.typeChecker.inferBinaryExprType(leftType, expr.operator, rightType);
    if (!resultType) {
      this.addDiagnostic(
        expr.loc,
        'error',
        `Invalid operation: ${this.typeChecker.typeToString(leftType)} ${expr.operator} ${this.typeChecker.typeToString(rightType)}`,
        ErrorCodes.TYPE_MISMATCH_EXPR,
      );
      return null;
    }

    return resultType;
  }

  private inferUnaryExprType(expr: UnaryExpr): DataType | null {
    const operandType = this.inferExprType(expr.operand);
    if (!operandType) return null;

    const resultType = this.typeChecker.inferUnaryExprType(expr.operator, operandType);
    if (!resultType) {
      this.addDiagnostic(
        expr.loc,
        'error',
        `Invalid unary operation: ${expr.operator} ${this.typeChecker.typeToString(operandType)}`,
        ErrorCodes.TYPE_MISMATCH_EXPR,
      );
      return null;
    }

    return resultType;
  }

  private analyzeFunctionCall(call: FunctionCallExpr): DataType | null {
    const sym = this.symbolTable.resolve(call.name);

    if (!sym) {
      // Check #4: undefined function/FB call
      this.addDiagnostic(
        call.loc,
        'error',
        `Undefined function or function block '${call.name}'`,
        ErrorCodes.UNDEFINED_FUNCTION,
      );
      // Still analyze arguments for further errors
      for (const arg of call.args) this.inferExprType(arg);
      if (call.namedArgs) {
        for (const na of call.namedArgs) this.inferExprType(na.value);
      }
      return null;
    }

    sym.isUsed = true;

    // --- Standard function call ---
    if (sym.kind === 'function' && sym.parameters) {
      return this.checkFunctionArgs(call, sym);
    }

    // --- Function block instance call (FB_name(arg := val, ...)) ---
    if (sym.kind === 'functionBlock' || (sym.dataType.kind === 'functionBlock')) {
      return this.checkFBCall(call, sym);
    }

    // --- Variable used as function block (myTimer(IN := x, PT := y)) ---
    if (sym.kind === 'variable' && (sym.dataType.kind as string) === 'functionBlock') {
      return this.checkFBCall(call, sym);
    }

    // For other cases (e.g. type conversion functions resolved as functions)
    for (const arg of call.args) this.inferExprType(arg);
    return sym.returnType ?? sym.dataType;
  }

  private checkFunctionArgs(call: FunctionCallExpr, sym: Symbol): DataType | null {
    const params = sym.parameters!;
    const argTypes: DataType[] = [];

    // Check #5: wrong number of arguments
    // Some IEC functions are variadic (MAX, MIN, CONCAT, MUX) - allow >= min params
    const isVariadic = ['MAX', 'MIN', 'CONCAT', 'MUX'].includes(call.name.toUpperCase());
    if (!isVariadic && call.args.length !== params.length) {
      this.addDiagnostic(
        call.loc,
        'error',
        `Function '${call.name}' expects ${params.length} argument(s), got ${call.args.length}`,
        ErrorCodes.WRONG_ARG_COUNT,
      );
    }

    // Check #6: wrong argument types
    for (let i = 0; i < call.args.length; i++) {
      const argType = this.inferExprType(call.args[i]!);
      if (argType) argTypes.push(argType);

      if (i < params.length && argType) {
        if (!this.typeChecker.isAssignableTo(argType, params[i]!.type)) {
          this.addDiagnostic(
            call.args[i]!.loc,
            'error',
            `Argument ${i + 1} of '${call.name}': expected ${this.typeChecker.typeToString(params[i]!.type)}, got ${this.typeChecker.typeToString(argType)}`,
            ErrorCodes.WRONG_ARG_TYPE,
          );
        }
      }
    }

    // Infer return type
    if (sym.returnType) {
      return this.typeChecker.inferFunctionReturnType(sym.returnType, params, argTypes);
    }
    return sym.dataType;
  }

  private checkFBCall(call: FunctionCallExpr, sym: Symbol): DataType | null {
    const fbType = sym.dataType as FunctionBlockType;

    // FB calls use named arguments
    if (call.namedArgs && call.namedArgs.length > 0) {
      for (const na of call.namedArgs) {
        const argType = this.inferExprType(na.value);
        // Find matching input/inOut parameter
        const param = fbType.inputs.find(p => p.name.toUpperCase() === na.name.toUpperCase())
          || (fbType.inOuts ?? []).find(p => p.name.toUpperCase() === na.name.toUpperCase());

        if (!param) {
          this.addDiagnostic(
            na.value.loc,
            'error',
            `Function block '${fbType.name}' has no input '${na.name}'`,
            ErrorCodes.WRONG_ARG_COUNT,
          );
        } else if (argType && !this.typeChecker.isAssignableTo(argType, param.type)) {
          this.addDiagnostic(
            na.value.loc,
            'error',
            `Parameter '${na.name}' of '${fbType.name}': expected ${this.typeChecker.typeToString(param.type)}, got ${this.typeChecker.typeToString(argType)}`,
            ErrorCodes.WRONG_ARG_TYPE,
          );
        }
      }
    } else if (call.args.length > 0) {
      // Positional args (less common for FBs but valid)
      const allInputs = [...fbType.inputs, ...(fbType.inOuts ?? [])];
      if (call.args.length > allInputs.length) {
        this.addDiagnostic(
          call.loc,
          'error',
          `Function block '${fbType.name}' expects at most ${allInputs.length} argument(s), got ${call.args.length}`,
          ErrorCodes.WRONG_ARG_COUNT,
        );
      }
      for (let i = 0; i < call.args.length && i < allInputs.length; i++) {
        const argType = this.inferExprType(call.args[i]!);
        if (argType && !this.typeChecker.isAssignableTo(argType, allInputs[i]!.type)) {
          this.addDiagnostic(
            call.args[i]!.loc,
            'error',
            `Argument ${i + 1} of '${fbType.name}': expected ${this.typeChecker.typeToString(allInputs[i]!.type)}, got ${this.typeChecker.typeToString(argType)}`,
            ErrorCodes.WRONG_ARG_TYPE,
          );
        }
      }
    }

    // FB call doesn't return a value directly (access via .Q, .OUT etc.)
    return { kind: 'unknown' };
  }

  private inferMemberAccessType(expr: MemberAccessExpr): DataType | null {
    const objectType = this.inferExprType(expr.object);
    if (!objectType) return null;

    // Struct member access
    if (objectType.kind === 'struct') {
      const field = objectType.fields.find(f => f.name.toUpperCase() === expr.member.toUpperCase());
      if (field) return field.type;
      this.addDiagnostic(
        expr.loc,
        'error',
        `Struct '${objectType.name}' has no member '${expr.member}'`,
        ErrorCodes.UNDEFINED_VARIABLE,
      );
      return null;
    }

    // FB output access (e.g. myTimer.Q, myTimer.ET)
    if (objectType.kind === 'functionBlock') {
      const output = objectType.outputs.find(p => p.name.toUpperCase() === expr.member.toUpperCase());
      if (output) return output.type;
      const input = objectType.inputs.find(p => p.name.toUpperCase() === expr.member.toUpperCase());
      if (input) return input.type;
      this.addDiagnostic(
        expr.loc,
        'error',
        `Function block '${objectType.name}' has no member '${expr.member}'`,
        ErrorCodes.UNDEFINED_VARIABLE,
      );
      return null;
    }

    return { kind: 'unknown' };
  }

  private inferArrayAccessType(expr: ArrayAccessExpr): DataType | null {
    const arrayType = this.inferExprType(expr.array);
    const indexType = this.inferExprType(expr.index);

    if (arrayType && arrayType.kind === 'array') {
      // Check index type is integer
      if (indexType && !this.typeChecker.isIntegerType(indexType)) {
        this.addDiagnostic(
          expr.index.loc,
          'error',
          `Array index must be integer type, got ${this.typeChecker.typeToString(indexType)}`,
          ErrorCodes.TYPE_MISMATCH_EXPR,
        );
      }

      // Check #18: array index out of bounds (literal)
      if (expr.index.type === 'IntegerLiteral') {
        const idx = expr.index.value;
        if (idx < arrayType.lowerBound || idx > arrayType.upperBound) {
          this.addDiagnostic(
            expr.index.loc,
            'warning',
            `Array index ${idx} is out of bounds [${arrayType.lowerBound}..${arrayType.upperBound}]`,
            ErrorCodes.ARRAY_OUT_OF_BOUNDS,
          );
        }
      }

      return arrayType.elementType;
    }

    return { kind: 'unknown' };
  }

  // ── Helper checks ──────────────────────────────────────────────────────

  private checkBoolCondition(condType: DataType | null, loc: ASTLocation, context: string): void {
    if (condType && !this.typeChecker.isBoolType(condType) && condType.kind !== 'unknown') {
      this.addDiagnostic(
        loc,
        'error',
        `${context} condition must be BOOL, got ${this.typeChecker.typeToString(condType)}`,
        ErrorCodes.TYPE_MISMATCH_EXPR,
      );
    }
  }

  private checkDuplicatePOU(name: string, loc: ASTLocation): void {
    const upper = name.toUpperCase();
    if (this.pouNames.has(upper)) {
      this.addDiagnostic(
        loc,
        'error',
        `Duplicate POU name: '${name}'`,
        ErrorCodes.DUPLICATE_POU,
      );
    }
    this.pouNames.add(upper);
  }

  /** Check #7: unused variables */
  private checkUnusedSymbols(): void {
    const unused = this.symbolTable.getUnusedSymbols();
    for (const sym of unused) {
      this.addDiagnostic(
        sym.location,
        'warning',
        `Variable '${sym.name}' is declared but never used`,
        ErrorCodes.UNUSED_VARIABLE,
      );
    }
  }

  /** Check #17: literal division by zero */
  private checkDivisionByZero(expr: Expression): void {
    if (expr.type === 'BinaryExpr' && (expr.operator === '/' || expr.operator.toUpperCase() === 'MOD')) {
      if (expr.right.type === 'IntegerLiteral' && expr.right.value === 0) {
        this.addDiagnostic(
          expr.right.loc,
          'warning',
          'Division by zero',
          ErrorCodes.DIVISION_BY_ZERO,
        );
      }
      if (expr.right.type === 'RealLiteral' && expr.right.value === 0.0) {
        this.addDiagnostic(
          expr.right.loc,
          'warning',
          'Division by zero',
          ErrorCodes.DIVISION_BY_ZERO,
        );
      }
    }
  }

  /** Check if a body contains at least one RETURN statement */
  private bodyHasReturn(stmts: Statement[]): boolean {
    for (const stmt of stmts) {
      if (stmt.type === 'ReturnStatement') return true;
      if (stmt.type === 'IfStatement') {
        const thenHas = this.bodyHasReturn(stmt.thenBranch);
        const elseHas = stmt.elseBranch ? this.bodyHasReturn(stmt.elseBranch) : false;
        if (thenHas && elseHas) return true;
      }
    }
    return false;
  }

  /** Check if a body contains an EXIT statement */
  private bodyHasExit(stmts: Statement[]): boolean {
    for (const stmt of stmts) {
      if (stmt.type === 'ExitStatement') return true;
      if (stmt.type === 'IfStatement') {
        if (this.bodyHasExit(stmt.thenBranch)) return true;
        if (stmt.elseBranch && this.bodyHasExit(stmt.elseBranch)) return true;
      }
    }
    return false;
  }

  // ── Type resolution ────────────────────────────────────────────────────

  /** Resolve a type name string to a DataType */
  private resolveTypeName(name: string): DataType {
    const upper = name.toUpperCase();
    const elementaryTypes: Set<string> = new Set([
      'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD',
      'SINT', 'INT', 'DINT', 'LINT',
      'USINT', 'UINT', 'UDINT', 'ULINT',
      'REAL', 'LREAL',
      'STRING', 'WSTRING',
      'TIME', 'DATE', 'TOD', 'DT',
      'ANY', 'ANY_NUM', 'ANY_INT', 'ANY_REAL', 'ANY_BIT', 'ANY_STRING', 'ANY_DATE',
    ]);

    if (elementaryTypes.has(upper)) {
      return elementary(upper as ElementaryType);
    }

    // Check if it's a known FB type
    const sym = this.symbolTable.resolve(upper);
    if (sym && sym.kind === 'functionBlock') {
      return sym.dataType;
    }

    return { kind: 'userDefined', name: upper };
  }

  /** Resolve a VarDeclaration to a DataType */
  private resolveVarType(decl: VarDeclaration): DataType {
    if (decl.arrayBounds && decl.elementType) {
      return {
        kind: 'array',
        elementType: this.resolveTypeName(decl.elementType),
        lowerBound: decl.arrayBounds.lower,
        upperBound: decl.arrayBounds.upper,
      };
    }
    return this.resolveTypeName(decl.dataType);
  }

  // ── Diagnostics emission ───────────────────────────────────────────────

  private addDiagnostic(
    loc: ASTLocation,
    severity: DiagnosticSeverity,
    message: string,
    code: string,
  ): void {
    if (this.diagnostics.length >= MAX_DIAGNOSTICS) return;

    this.diagnostics.push({
      range: this.toRange(loc),
      severity,
      message,
      code,
      source: 'st-semantic',
    });
  }

  private toRange(loc: ASTLocation): SourceRange {
    return {
      startLine: loc.startLine,
      startCol: loc.startCol,
      endLine: loc.endLine,
      endCol: loc.endCol,
    };
  }
}
