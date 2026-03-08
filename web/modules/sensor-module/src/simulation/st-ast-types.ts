/**
 * IEC 61131-3 Structured Text AST Type Definitions (Frontend Mirror)
 *
 * This file is a MANUAL mirror of the backend AST definitions found at:
 *   apps/sensor-service/src/automation/compiler/parser/st-ast.ts
 *
 * It must be kept in sync with the backend whenever the AST schema changes.
 * The backend is the source of truth — any new node types, fields, or
 * discriminant values added there MUST be reflected here.
 *
 * WHY a copy? The backend lives in a separate NestJS workspace with
 * server-only dependencies. Frontend modules cannot import from it directly.
 * Until a shared-types package bridges both sides, this mirror is the
 * contract that the browser-side interpreter, parser-lite, and UI components
 * rely on.
 *
 * Coverage (full backend parity):
 *   - POU: PROGRAM, FUNCTION_BLOCK, FUNCTION, METHOD, PROPERTY, INTERFACE
 *   - Declarations: VarBlock, VarDeclaration, TypeDeclaration
 *   - Type nodes: Elementary, Array, String, Struct, Enum, Named, Subrange
 *   - Statements: Assignment, If, Case, For, While, Repeat, Return, Exit,
 *                 ExpressionStatement, Empty
 *   - Expressions: Binary, Unary, FunctionCall, ArrayAccess, MemberAccess,
 *                  Deref, Identifier, all literal variants (Integer, Real,
 *                  String, Boolean, Time, Date, Hex, Octal, BinaryLiteral),
 *                  Parenthesized
 *   - Parse result & error types
 *
 * Last synced with backend: 2026-03-08
 */

// ────────────────────────────────────────────────────────────────────────────
// Source Location
// ────────────────────────────────────────────────────────────────────────────

/** 1-based source location range used for diagnostics and IDE features. */
export interface SourceLocation {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Top-Level AST Node (Discriminated Union)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Top-level AST node — discriminated union over `kind`.
 * A single ST source file may produce multiple top-level nodes
 * (e.g. several PROGRAM / FUNCTION_BLOCK / TYPE declarations).
 */
export type ASTNode =
  | ProgramNode
  | FunctionBlockNode
  | FunctionNode
  | InterfaceNode
  | TypeDeclarationNode;

// ────────────────────────────────────────────────────────────────────────────
// POU Nodes (Program Organisation Units)
// ────────────────────────────────────────────────────────────────────────────

/** A PROGRAM ... END_PROGRAM block. */
export interface ProgramNode {
  kind: 'program';
  name: string;
  varBlocks: VarBlockNode[];
  body: Statement[];
  location: SourceLocation;
}

/** A FUNCTION_BLOCK ... END_FUNCTION_BLOCK block. */
export interface FunctionBlockNode {
  kind: 'functionBlock';
  name: string;
  implements?: string[];
  extends?: string;
  varBlocks: VarBlockNode[];
  methods: MethodNode[];
  properties: PropertyNode[];
  body: Statement[];
  location: SourceLocation;
}

/** A FUNCTION ... END_FUNCTION block. */
export interface FunctionNode {
  kind: 'function';
  name: string;
  returnType: TypeNode;
  varBlocks: VarBlockNode[];
  body: Statement[];
  location: SourceLocation;
}

/** A METHOD ... END_METHOD block inside a FUNCTION_BLOCK. */
export interface MethodNode {
  kind: 'method';
  name: string;
  returnType?: TypeNode;
  accessSpecifier?: 'PUBLIC' | 'PRIVATE' | 'PROTECTED' | 'INTERNAL';
  varBlocks: VarBlockNode[];
  body: Statement[];
  location: SourceLocation;
}

/** A PROPERTY ... END_PROPERTY block with optional getter / setter. */
export interface PropertyNode {
  kind: 'property';
  name: string;
  propertyType: TypeNode;
  getter?: MethodNode;
  setter?: MethodNode;
  location: SourceLocation;
}

/** An INTERFACE ... END_INTERFACE block. */
export interface InterfaceNode {
  kind: 'interface';
  name: string;
  extends?: string[];
  methods: MethodSignatureNode[];
  properties: PropertySignatureNode[];
  location: SourceLocation;
}

/** Method signature within an INTERFACE (no body). */
export interface MethodSignatureNode {
  kind: 'methodSignature';
  name: string;
  returnType?: TypeNode;
  varBlocks: VarBlockNode[];
  location: SourceLocation;
}

/** Property signature within an INTERFACE (no getter/setter body). */
export interface PropertySignatureNode {
  kind: 'propertySignature';
  name: string;
  propertyType: TypeNode;
  location: SourceLocation;
}

// ────────────────────────────────────────────────────────────────────────────
// Variable Declaration Nodes
// ────────────────────────────────────────────────────────────────────────────

/** Discriminant values for VAR block sections. */
export type VarBlockKind =
  | 'VAR'
  | 'VAR_INPUT'
  | 'VAR_OUTPUT'
  | 'VAR_IN_OUT'
  | 'VAR_GLOBAL'
  | 'VAR_TEMP'
  | 'VAR_EXTERNAL';

/** A VAR / VAR_INPUT / ... / END_VAR block containing declarations. */
export interface VarBlockNode {
  kind: 'varBlock';
  blockType: VarBlockKind;
  constant: boolean;
  retain: boolean;
  persistent: boolean;
  declarations: VarDeclarationNode[];
  location: SourceLocation;
}

/** A single variable declaration line (may declare multiple names). */
export interface VarDeclarationNode {
  kind: 'varDeclaration';
  names: string[];
  type: TypeNode;
  initialValue?: Expression;
  /** Direct address binding, e.g. AT %IX0.0 */
  atAddress?: string;
  location: SourceLocation;
}

// ────────────────────────────────────────────────────────────────────────────
// Type Nodes
// ────────────────────────────────────────────────────────────────────────────

/** Discriminated union of all type-describing AST nodes. */
export type TypeNode =
  | ElementaryTypeNode
  | ArrayTypeNode
  | StringTypeNode
  | StructTypeNode
  | EnumTypeNode
  | NamedTypeNode
  | SubrangeTypeNode;

/** An elementary / built-in type: BOOL, INT, DINT, REAL, LREAL, TIME, DATE, etc. */
export interface ElementaryTypeNode {
  kind: 'elementaryType';
  name: string;
  location: SourceLocation;
}

/** An ARRAY[lo..hi, ...] OF elementType declaration. */
export interface ArrayTypeNode {
  kind: 'arrayType';
  /** Dimension ranges: [[lower, upper], ...] for multi-dimensional arrays. */
  dimensions: ArrayDimension[];
  elementType: TypeNode;
  location: SourceLocation;
}

/** A single array dimension range (lower..upper). */
export interface ArrayDimension {
  lower: Expression;
  upper: Expression;
}

/** A STRING or WSTRING type, optionally length-constrained. */
export interface StringTypeNode {
  kind: 'stringType';
  /** STRING or WSTRING */
  baseType: 'STRING' | 'WSTRING';
  /** Optional max length expression, e.g. STRING[80]. */
  maxLength?: Expression;
  location: SourceLocation;
}

/** A STRUCT ... END_STRUCT type definition. */
export interface StructTypeNode {
  kind: 'structType';
  members: StructMemberNode[];
  location: SourceLocation;
}

/** A single member within a STRUCT. */
export interface StructMemberNode {
  kind: 'structMember';
  name: string;
  type: TypeNode;
  initialValue?: Expression;
  location: SourceLocation;
}

/** An enumeration type: (val1, val2 := 3, ...). */
export interface EnumTypeNode {
  kind: 'enumType';
  /** Optional underlying base type (DINT, INT, ...). */
  baseType?: TypeNode;
  members: EnumMemberNode[];
  location: SourceLocation;
}

/** A single member of an enumeration. */
export interface EnumMemberNode {
  kind: 'enumMember';
  name: string;
  value?: Expression;
  location: SourceLocation;
}

/** A reference to a user-defined type by name. */
export interface NamedTypeNode {
  kind: 'namedType';
  name: string;
  location: SourceLocation;
}

/** A subrange type: baseType (lower..upper). */
export interface SubrangeTypeNode {
  kind: 'subrangeType';
  baseType: TypeNode;
  lower: Expression;
  upper: Expression;
  location: SourceLocation;
}

// ────────────────────────────────────────────────────────────────────────────
// Type Declaration Node (TYPE ... END_TYPE)
// ────────────────────────────────────────────────────────────────────────────

/** A top-level TYPE myType : ... ; END_TYPE declaration. */
export interface TypeDeclarationNode {
  kind: 'typeDeclaration';
  name: string;
  type: TypeNode;
  location: SourceLocation;
}

// ────────────────────────────────────────────────────────────────────────────
// Statement Nodes
// ────────────────────────────────────────────────────────────────────────────

/** Discriminated union of all statement AST nodes. */
export type Statement =
  | AssignmentStatement
  | IfStatement
  | CaseStatement
  | ForStatement
  | WhileStatement
  | RepeatStatement
  | ReturnStatement
  | ExitStatement
  | ExpressionStatement
  | EmptyStatement;

/** target := value; */
export interface AssignmentStatement {
  kind: 'assignment';
  target: Expression;
  value: Expression;
  location: SourceLocation;
}

/** IF ... THEN ... ELSIF ... ELSE ... END_IF; */
export interface IfStatement {
  kind: 'ifStatement';
  condition: Expression;
  thenBody: Statement[];
  elsifBranches: ElsifBranch[];
  elseBody?: Statement[];
  location: SourceLocation;
}

/** A single ELSIF branch within an IF statement. */
export interface ElsifBranch {
  condition: Expression;
  body: Statement[];
  location: SourceLocation;
}

/** CASE expr OF ... END_CASE; */
export interface CaseStatement {
  kind: 'caseStatement';
  expression: Expression;
  cases: CaseBranch[];
  elseBody?: Statement[];
  location: SourceLocation;
}

/** A single branch in a CASE statement, with one or more labels. */
export interface CaseBranch {
  labels: CaseLabel[];
  body: Statement[];
  location: SourceLocation;
}

/** Case label: a single value or a range (1..5). */
export type CaseLabel =
  | { kind: 'single'; value: Expression }
  | { kind: 'range'; lower: Expression; upper: Expression };

/** FOR variable := from TO to [BY step] DO ... END_FOR; */
export interface ForStatement {
  kind: 'forStatement';
  variable: string;
  from: Expression;
  to: Expression;
  by?: Expression;
  body: Statement[];
  location: SourceLocation;
}

/** WHILE condition DO ... END_WHILE; */
export interface WhileStatement {
  kind: 'whileStatement';
  condition: Expression;
  body: Statement[];
  location: SourceLocation;
}

/** REPEAT ... UNTIL condition END_REPEAT; */
export interface RepeatStatement {
  kind: 'repeatStatement';
  body: Statement[];
  condition: Expression;
  location: SourceLocation;
}

/** RETURN; — exits the current POU. */
export interface ReturnStatement {
  kind: 'returnStatement';
  location: SourceLocation;
}

/** EXIT; — breaks out of the innermost loop. */
export interface ExitStatement {
  kind: 'exitStatement';
  location: SourceLocation;
}

/** An expression used as a statement (function calls, FB calls). */
export interface ExpressionStatement {
  kind: 'expressionStatement';
  expression: Expression;
  location: SourceLocation;
}

/** An empty statement (bare semicolon). */
export interface EmptyStatement {
  kind: 'emptyStatement';
  location: SourceLocation;
}

// ────────────────────────────────────────────────────────────────────────────
// Expression Nodes
// ────────────────────────────────────────────────────────────────────────────

/** Discriminated union of all expression AST nodes. */
export type Expression =
  | BinaryExpression
  | UnaryExpression
  | FunctionCallExpression
  | ArrayAccessExpression
  | MemberAccessExpression
  | DerefExpression
  | IdentifierExpression
  | IntegerLiteral
  | RealLiteral
  | StringLiteral
  | BooleanLiteral
  | TimeLiteral
  | DateLiteral
  | HexLiteral
  | OctalLiteral
  | BinaryLiteralExpr
  | ParenthesizedExpression;

/**
 * IEC 61131-3 binary operators.
 *
 * Precedence (low to high):
 *   1: OR
 *   2: XOR
 *   3: AND, &
 *   4: =, <>
 *   5: <, >, <=, >=
 *   6: +, - (additive)
 *   7: *, /, MOD
 *   8: ** (power)
 *   9: NOT, unary -, unary + (prefix — see UnaryOperator)
 *
 * Bitwise shift / rotate operators:
 *   SHL — shift left
 *   SHR — shift right
 *   ROL — rotate left
 *   ROR — rotate right
 */
export type BinaryOperator =
  | 'OR' | 'XOR' | 'AND'
  | '=' | '<>' | '<' | '>' | '<=' | '>='
  | '+' | '-' | '*' | '/' | 'MOD' | '**'
  | 'SHL' | 'SHR' | 'ROL' | 'ROR';

/** IEC 61131-3 unary (prefix) operators. */
export type UnaryOperator = 'NOT' | '-' | '+';

/** A binary operator expression: left op right. */
export interface BinaryExpression {
  kind: 'binaryExpression';
  operator: BinaryOperator;
  left: Expression;
  right: Expression;
  location: SourceLocation;
}

/** A unary prefix expression: op operand. */
export interface UnaryExpression {
  kind: 'unaryExpression';
  operator: UnaryOperator;
  operand: Expression;
  location: SourceLocation;
}

/** A function or function-block call expression. */
export interface FunctionCallExpression {
  kind: 'functionCall';
  name: string;
  /** Positional arguments. */
  args: Expression[];
  /** Named arguments: (IN := val, PT := val) for FB calls. */
  namedArgs: NamedArgument[];
  location: SourceLocation;
}

/** A named argument in a function / FB call. */
export interface NamedArgument {
  name: string;
  value: Expression;
  /** := for input, => for output. */
  assignType: 'input' | 'output';
  location: SourceLocation;
}

/** Array subscript access: array[i, j]. */
export interface ArrayAccessExpression {
  kind: 'arrayAccess';
  array: Expression;
  indices: Expression[];
  location: SourceLocation;
}

/** Member (dot) access: object.member. */
export interface MemberAccessExpression {
  kind: 'memberAccess';
  object: Expression;
  member: string;
  location: SourceLocation;
}

/** Pointer dereference: operand^ */
export interface DerefExpression {
  kind: 'deref';
  operand: Expression;
  location: SourceLocation;
}

/** A simple identifier reference. */
export interface IdentifierExpression {
  kind: 'identifier';
  name: string;
  location: SourceLocation;
}

// ── Literal Expressions ─────────────────────────────────────────────────────

/** Integer literal, e.g. 42, DINT#123. */
export interface IntegerLiteral {
  kind: 'integerLiteral';
  value: number;
  /** Raw text (preserves typed prefix like DINT#123). */
  raw: string;
  location: SourceLocation;
}

/** Real (floating-point) literal, e.g. 3.14, LREAL#1.0E-3. */
export interface RealLiteral {
  kind: 'realLiteral';
  value: number;
  raw: string;
  location: SourceLocation;
}

/** String literal, e.g. 'hello'. */
export interface StringLiteral {
  kind: 'stringLiteral';
  value: string;
  raw: string;
  location: SourceLocation;
}

/** Boolean literal: TRUE or FALSE. */
export interface BooleanLiteral {
  kind: 'booleanLiteral';
  value: boolean;
  raw: string;
  location: SourceLocation;
}

/** Time literal, e.g. T#1s, TIME#500ms. */
export interface TimeLiteral {
  kind: 'timeLiteral';
  raw: string;
  location: SourceLocation;
}

/** Date literal, e.g. D#2024-01-15, DATE#2024-01-15. */
export interface DateLiteral {
  kind: 'dateLiteral';
  raw: string;
  location: SourceLocation;
}

/** Hexadecimal literal, e.g. 16#FF, WORD#16#ABCD. */
export interface HexLiteral {
  kind: 'hexLiteral';
  raw: string;
  value: number;
  location: SourceLocation;
}

/** Octal literal, e.g. 8#77. */
export interface OctalLiteral {
  kind: 'octalLiteral';
  raw: string;
  value: number;
  location: SourceLocation;
}

/** Binary (base-2) literal, e.g. 2#1010_0011. */
export interface BinaryLiteralExpr {
  kind: 'binaryLiteral';
  raw: string;
  value: number;
  location: SourceLocation;
}

/** A parenthesized expression: (expr). */
export interface ParenthesizedExpression {
  kind: 'parenthesized';
  expression: Expression;
  location: SourceLocation;
}

// ────────────────────────────────────────────────────────────────────────────
// Parse Result
// ────────────────────────────────────────────────────────────────────────────

/** The result of parsing an ST source file. */
export interface ParseResult {
  ast: ASTNode[];
  errors: ParseError[];
}

/** A diagnostic produced during parsing. */
export interface ParseError {
  message: string;
  code: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  severity: 'error' | 'warning';
  hint?: string;
}
