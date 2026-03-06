/**
 * IEC 61131-3 Structured Text AST Node Definitions
 *
 * Complete type system using TypeScript discriminated unions.
 * Every node carries a SourceLocation for diagnostics and IDE features.
 *
 * Coverage:
 * - POU: PROGRAM, FUNCTION_BLOCK, FUNCTION, METHOD, PROPERTY, INTERFACE
 * - Declarations: VarBlock, VarDeclaration, TypeDeclaration, StructType, EnumType, ArrayType
 * - Statements: Assignment, If, Case, For, While, Repeat, Return, Exit, FBCall, FunctionCall, Empty
 * - Expressions: Binary, Unary, FunctionCall, ArrayAccess, MemberAccess, Literal, Identifier, Parenthesized
 */

// ────────────────────────────────────────────────────────────────────────────
// Source Location
// ────────────────────────────────────────────────────────────────────────────

/** 1-based source location range */
export interface SourceLocation {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Top-Level AST Node (Discriminated Union)
// ────────────────────────────────────────────────────────────────────────────

export type ASTNode =
  | ProgramNode
  | FunctionBlockNode
  | FunctionNode
  | InterfaceNode
  | TypeDeclarationNode;

// ────────────────────────────────────────────────────────────────────────────
// POU Nodes
// ────────────────────────────────────────────────────────────────────────────

export interface ProgramNode {
  kind: 'program';
  name: string;
  varBlocks: VarBlockNode[];
  body: Statement[];
  location: SourceLocation;
}

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

export interface FunctionNode {
  kind: 'function';
  name: string;
  returnType: TypeNode;
  varBlocks: VarBlockNode[];
  body: Statement[];
  location: SourceLocation;
}

export interface MethodNode {
  kind: 'method';
  name: string;
  returnType?: TypeNode;
  accessSpecifier?: 'PUBLIC' | 'PRIVATE' | 'PROTECTED' | 'INTERNAL';
  varBlocks: VarBlockNode[];
  body: Statement[];
  location: SourceLocation;
}

export interface PropertyNode {
  kind: 'property';
  name: string;
  propertyType: TypeNode;
  getter?: MethodNode;
  setter?: MethodNode;
  location: SourceLocation;
}

export interface InterfaceNode {
  kind: 'interface';
  name: string;
  extends?: string[];
  methods: MethodSignatureNode[];
  properties: PropertySignatureNode[];
  location: SourceLocation;
}

export interface MethodSignatureNode {
  kind: 'methodSignature';
  name: string;
  returnType?: TypeNode;
  varBlocks: VarBlockNode[];
  location: SourceLocation;
}

export interface PropertySignatureNode {
  kind: 'propertySignature';
  name: string;
  propertyType: TypeNode;
  location: SourceLocation;
}

// ────────────────────────────────────────────────────────────────────────────
// Variable Declaration Nodes
// ────────────────────────────────────────────────────────────────────────────

export type VarBlockKind =
  | 'VAR'
  | 'VAR_INPUT'
  | 'VAR_OUTPUT'
  | 'VAR_IN_OUT'
  | 'VAR_GLOBAL'
  | 'VAR_TEMP'
  | 'VAR_EXTERNAL';

export interface VarBlockNode {
  kind: 'varBlock';
  blockType: VarBlockKind;
  constant: boolean;
  retain: boolean;
  persistent: boolean;
  declarations: VarDeclarationNode[];
  location: SourceLocation;
}

export interface VarDeclarationNode {
  kind: 'varDeclaration';
  names: string[];
  type: TypeNode;
  initialValue?: Expression;
  /** Direct address binding: AT %IX0.0 */
  atAddress?: string;
  location: SourceLocation;
}

// ────────────────────────────────────────────────────────────────────────────
// Type Nodes
// ────────────────────────────────────────────────────────────────────────────

export type TypeNode =
  | ElementaryTypeNode
  | ArrayTypeNode
  | StringTypeNode
  | StructTypeNode
  | EnumTypeNode
  | NamedTypeNode
  | SubrangeTypeNode;

export interface ElementaryTypeNode {
  kind: 'elementaryType';
  name: string; // BOOL, INT, DINT, REAL, LREAL, TIME, DATE, etc.
  location: SourceLocation;
}

export interface ArrayTypeNode {
  kind: 'arrayType';
  /** Dimension ranges: [[lower, upper], ...] for multi-dimensional */
  dimensions: ArrayDimension[];
  elementType: TypeNode;
  location: SourceLocation;
}

export interface ArrayDimension {
  lower: Expression;
  upper: Expression;
}

export interface StringTypeNode {
  kind: 'stringType';
  /** STRING or WSTRING */
  baseType: 'STRING' | 'WSTRING';
  /** Optional max length: STRING[80] */
  maxLength?: Expression;
  location: SourceLocation;
}

export interface StructTypeNode {
  kind: 'structType';
  members: StructMemberNode[];
  location: SourceLocation;
}

export interface StructMemberNode {
  kind: 'structMember';
  name: string;
  type: TypeNode;
  initialValue?: Expression;
  location: SourceLocation;
}

export interface EnumTypeNode {
  kind: 'enumType';
  /** Optional base type (DINT, INT, ...) */
  baseType?: TypeNode;
  members: EnumMemberNode[];
  location: SourceLocation;
}

export interface EnumMemberNode {
  kind: 'enumMember';
  name: string;
  value?: Expression;
  location: SourceLocation;
}

export interface NamedTypeNode {
  kind: 'namedType';
  name: string;
  location: SourceLocation;
}

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

export interface TypeDeclarationNode {
  kind: 'typeDeclaration';
  name: string;
  type: TypeNode;
  location: SourceLocation;
}

// ────────────────────────────────────────────────────────────────────────────
// Statement Nodes
// ────────────────────────────────────────────────────────────────────────────

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

export interface AssignmentStatement {
  kind: 'assignment';
  target: Expression;
  value: Expression;
  location: SourceLocation;
}

export interface IfStatement {
  kind: 'ifStatement';
  condition: Expression;
  thenBody: Statement[];
  elsifBranches: ElsifBranch[];
  elseBody?: Statement[];
  location: SourceLocation;
}

export interface ElsifBranch {
  condition: Expression;
  body: Statement[];
  location: SourceLocation;
}

export interface CaseStatement {
  kind: 'caseStatement';
  expression: Expression;
  cases: CaseBranch[];
  elseBody?: Statement[];
  location: SourceLocation;
}

export interface CaseBranch {
  labels: CaseLabel[];
  body: Statement[];
  location: SourceLocation;
}

/** Case label: single value, range (1..5), or comma-separated */
export type CaseLabel =
  | { kind: 'single'; value: Expression }
  | { kind: 'range'; lower: Expression; upper: Expression };

export interface ForStatement {
  kind: 'forStatement';
  variable: string;
  from: Expression;
  to: Expression;
  by?: Expression;
  body: Statement[];
  location: SourceLocation;
}

export interface WhileStatement {
  kind: 'whileStatement';
  condition: Expression;
  body: Statement[];
  location: SourceLocation;
}

export interface RepeatStatement {
  kind: 'repeatStatement';
  body: Statement[];
  condition: Expression;
  location: SourceLocation;
}

export interface ReturnStatement {
  kind: 'returnStatement';
  location: SourceLocation;
}

export interface ExitStatement {
  kind: 'exitStatement';
  location: SourceLocation;
}

/** Expression used as statement (function calls, FB calls) */
export interface ExpressionStatement {
  kind: 'expressionStatement';
  expression: Expression;
  location: SourceLocation;
}

export interface EmptyStatement {
  kind: 'emptyStatement';
  location: SourceLocation;
}

// ────────────────────────────────────────────────────────────────────────────
// Expression Nodes
// ────────────────────────────────────────────────────────────────────────────

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

/** IEC 61131-3 operator precedence (low to high):
 *  1: OR
 *  2: XOR
 *  3: AND, &
 *  4: =, <>
 *  5: <, >, <=, >=
 *  6: +, - (additive)
 *  7: *, /, MOD
 *  8: ** (power)
 *  9: NOT, unary -, unary + (prefix)
 */
export type BinaryOperator =
  | 'OR' | 'XOR' | 'AND'
  | '=' | '<>' | '<' | '>' | '<=' | '>='
  | '+' | '-' | '*' | '/' | 'MOD' | '**'
  | 'SHL' | 'SHR' | 'ROL' | 'ROR';

export type UnaryOperator = 'NOT' | '-' | '+';

export interface BinaryExpression {
  kind: 'binaryExpression';
  operator: BinaryOperator;
  left: Expression;
  right: Expression;
  location: SourceLocation;
}

export interface UnaryExpression {
  kind: 'unaryExpression';
  operator: UnaryOperator;
  operand: Expression;
  location: SourceLocation;
}

export interface FunctionCallExpression {
  kind: 'functionCall';
  name: string;
  /** Positional arguments */
  args: Expression[];
  /** Named arguments: (IN := val, PT := val) for FB calls */
  namedArgs: NamedArgument[];
  location: SourceLocation;
}

export interface NamedArgument {
  name: string;
  value: Expression;
  /** := for input, => for output */
  assignType: 'input' | 'output';
  location: SourceLocation;
}

export interface ArrayAccessExpression {
  kind: 'arrayAccess';
  array: Expression;
  indices: Expression[];
  location: SourceLocation;
}

export interface MemberAccessExpression {
  kind: 'memberAccess';
  object: Expression;
  member: string;
  location: SourceLocation;
}

export interface DerefExpression {
  kind: 'deref';
  operand: Expression;
  location: SourceLocation;
}

export interface IdentifierExpression {
  kind: 'identifier';
  name: string;
  location: SourceLocation;
}

// ── Literal Expressions ───────────────────────────────────────────────────

export interface IntegerLiteral {
  kind: 'integerLiteral';
  value: number;
  /** Raw text (preserves typed prefix like DINT#123) */
  raw: string;
  location: SourceLocation;
}

export interface RealLiteral {
  kind: 'realLiteral';
  value: number;
  raw: string;
  location: SourceLocation;
}

export interface StringLiteral {
  kind: 'stringLiteral';
  value: string;
  raw: string;
  location: SourceLocation;
}

export interface BooleanLiteral {
  kind: 'booleanLiteral';
  value: boolean;
  raw: string;
  location: SourceLocation;
}

export interface TimeLiteral {
  kind: 'timeLiteral';
  raw: string;
  location: SourceLocation;
}

export interface DateLiteral {
  kind: 'dateLiteral';
  raw: string;
  location: SourceLocation;
}

export interface HexLiteral {
  kind: 'hexLiteral';
  raw: string;
  value: number;
  location: SourceLocation;
}

export interface OctalLiteral {
  kind: 'octalLiteral';
  raw: string;
  value: number;
  location: SourceLocation;
}

export interface BinaryLiteralExpr {
  kind: 'binaryLiteral';
  raw: string;
  value: number;
  location: SourceLocation;
}

export interface ParenthesizedExpression {
  kind: 'parenthesized';
  expression: Expression;
  location: SourceLocation;
}

// ────────────────────────────────────────────────────────────────────────────
// Parse Result
// ────────────────────────────────────────────────────────────────────────────

export interface ParseResult {
  ast: ASTNode[];
  errors: ParseError[];
}

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
