/**
 * AST Adapter: Parser AST → Semantic Analyzer AST
 *
 * The parser (st-ast.ts) uses `kind` + `location` discriminated unions.
 * The semantic analyzer uses `type` + `loc` discriminated unions.
 * This adapter converts parser output to analyzer input format.
 */

import type {
  ASTNode as ParserASTNode,
  ProgramNode,
  FunctionBlockNode,
  FunctionNode,
  VarBlockNode,
  VarDeclarationNode,
  TypeNode,
  Statement as ParserStatement,
  Expression as ParserExpression,
  SourceLocation,
  ElsifBranch,
  CaseBranch,
  CaseLabel,
  NamedArgument,
} from '../parser/st-ast';

import type {
  ASTNode as AnalyzerASTNode,
  ProgramDecl,
  FunctionDecl,
  FunctionBlockDecl,
  VarBlock,
  VarDeclaration,
  Statement as AnalyzerStatement,
  Expression as AnalyzerExpression,
  ASTLocation,
} from './semantic-analyzer';

import type { VariableScope } from './symbol-table';

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Convert an array of parser AST nodes to analyzer AST nodes.
 * Skips node types the analyzer doesn't handle (interfaces, type declarations).
 */
export function adaptParserAST(parserNodes: ParserASTNode[]): AnalyzerASTNode[] {
  const result: AnalyzerASTNode[] = [];
  for (const node of parserNodes) {
    const adapted = adaptNode(node);
    if (adapted) result.push(adapted);
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────────────
// Node Adapters
// ────────────────────────────────────────────────────────────────────────────

function adaptNode(node: ParserASTNode): AnalyzerASTNode | null {
  switch (node.kind) {
    case 'program':
      return adaptProgram(node);
    case 'functionBlock':
      return adaptFunctionBlock(node);
    case 'function':
      return adaptFunction(node);
    case 'interface':
    case 'typeDeclaration':
      // Analyzer doesn't handle these yet
      return null;
  }
}

function adaptProgram(node: ProgramNode): ProgramDecl {
  return {
    type: 'Program',
    name: node.name,
    varBlocks: node.varBlocks.map(adaptVarBlock),
    body: node.body.map(adaptStatement),
    loc: adaptLocation(node.location),
  };
}

function adaptFunctionBlock(node: FunctionBlockNode): FunctionBlockDecl {
  return {
    type: 'FunctionBlock',
    name: node.name,
    varBlocks: node.varBlocks.map(adaptVarBlock),
    body: node.body.map(adaptStatement),
    loc: adaptLocation(node.location),
  };
}

function adaptFunction(node: FunctionNode): FunctionDecl {
  return {
    type: 'Function',
    name: node.name,
    returnType: resolveTypeNodeName(node.returnType),
    varBlocks: node.varBlocks.map(adaptVarBlock),
    body: node.body.map(adaptStatement),
    loc: adaptLocation(node.location),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Variable Block Adapters
// ────────────────────────────────────────────────────────────────────────────

const VAR_BLOCK_KIND_TO_SCOPE: Record<string, VariableScope> = {
  'VAR': 'VAR',
  'VAR_INPUT': 'VAR_INPUT',
  'VAR_OUTPUT': 'VAR_OUTPUT',
  'VAR_IN_OUT': 'VAR_IN_OUT',
  'VAR_GLOBAL': 'VAR_GLOBAL',
  'VAR_TEMP': 'VAR_TEMP',
  'VAR_EXTERNAL': 'VAR_EXTERNAL',
};

function adaptVarBlock(block: VarBlockNode): VarBlock {
  // Parser has one VarDeclarationNode per declaration with names: string[]
  // Analyzer expects one VarDeclaration per variable name
  const declarations: VarDeclaration[] = [];
  for (const decl of block.declarations) {
    for (const name of decl.names) {
      declarations.push(adaptVarDeclaration(name, decl));
    }
  }

  return {
    type: 'VarBlock',
    scope: VAR_BLOCK_KIND_TO_SCOPE[block.blockType] || 'VAR',
    isConstant: block.constant,
    isRetain: block.retain,
    declarations,
    loc: adaptLocation(block.location),
  };
}

function adaptVarDeclaration(name: string, decl: VarDeclarationNode): VarDeclaration {
  const dataType = resolveTypeNodeName(decl.type);
  const result: VarDeclaration = {
    type: 'VarDeclaration',
    name,
    dataType,
    isConstant: false,
    loc: adaptLocation(decl.location),
  };

  // Handle array types
  if (decl.type.kind === 'arrayType') {
    const dim = decl.type.dimensions[0];
    if (dim) {
      const lower = extractLiteralValue(dim.lower);
      const upper = extractLiteralValue(dim.upper);
      if (lower !== undefined && upper !== undefined) {
        result.arrayBounds = { lower, upper };
        result.elementType = resolveTypeNodeName(decl.type.elementType);
      }
    }
  }

  // Handle initial value
  if (decl.initialValue) {
    result.initialValue = adaptExpression(decl.initialValue);
  }

  return result;
}

// ────────────────────────────────────────────────────────────────────────────
// Statement Adapters
// ────────────────────────────────────────────────────────────────────────────

function adaptStatement(stmt: ParserStatement): AnalyzerStatement {
  switch (stmt.kind) {
    case 'assignment':
      return {
        type: 'Assignment',
        target: adaptExpression(stmt.target),
        value: adaptExpression(stmt.value),
        loc: adaptLocation(stmt.location),
      };

    case 'ifStatement':
      return {
        type: 'IfStatement',
        condition: adaptExpression(stmt.condition),
        thenBranch: stmt.thenBody.map(adaptStatement),
        elsifBranches: stmt.elsifBranches.map((b: ElsifBranch) => ({
          condition: adaptExpression(b.condition),
          body: b.body.map(adaptStatement),
        })),
        elseBranch: stmt.elseBody ? stmt.elseBody.map(adaptStatement) : undefined,
        loc: adaptLocation(stmt.location),
      };

    case 'caseStatement':
      return {
        type: 'CaseStatement',
        expression: adaptExpression(stmt.expression),
        cases: stmt.cases.map((c: CaseBranch) => ({
          values: c.labels.map(adaptCaseLabel),
          body: c.body.map(adaptStatement),
        })),
        elseBody: stmt.elseBody ? stmt.elseBody.map(adaptStatement) : undefined,
        loc: adaptLocation(stmt.location),
      };

    case 'forStatement':
      return {
        type: 'ForStatement',
        variable: stmt.variable,
        from: adaptExpression(stmt.from),
        to: adaptExpression(stmt.to),
        by: stmt.by ? adaptExpression(stmt.by) : undefined,
        body: stmt.body.map(adaptStatement),
        loc: adaptLocation(stmt.location),
      };

    case 'whileStatement':
      return {
        type: 'WhileStatement',
        condition: adaptExpression(stmt.condition),
        body: stmt.body.map(adaptStatement),
        loc: adaptLocation(stmt.location),
      };

    case 'repeatStatement':
      return {
        type: 'RepeatStatement',
        condition: adaptExpression(stmt.condition),
        body: stmt.body.map(adaptStatement),
        loc: adaptLocation(stmt.location),
      };

    case 'returnStatement':
      return {
        type: 'ReturnStatement',
        loc: adaptLocation(stmt.location),
      };

    case 'exitStatement':
      return {
        type: 'ExitStatement',
        loc: adaptLocation(stmt.location),
      };

    case 'expressionStatement':
      // If the expression is a function call, wrap as FunctionCallStatement
      const expr = adaptExpression(stmt.expression);
      if (expr.type === 'FunctionCall') {
        return {
          type: 'FunctionCallStatement',
          call: expr,
          loc: adaptLocation(stmt.location),
        };
      }
      // Fallback: treat as empty (analyzer doesn't have a general expression statement)
      return {
        type: 'EmptyStatement',
        loc: adaptLocation(stmt.location),
      };

    case 'emptyStatement':
      return {
        type: 'EmptyStatement',
        loc: adaptLocation(stmt.location),
      };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Expression Adapters
// ────────────────────────────────────────────────────────────────────────────

function adaptExpression(expr: ParserExpression): AnalyzerExpression {
  switch (expr.kind) {
    case 'identifier':
      return {
        type: 'Identifier',
        name: expr.name,
        loc: adaptLocation(expr.location),
      };

    case 'integerLiteral':
      return {
        type: 'IntegerLiteral',
        value: expr.value,
        loc: adaptLocation(expr.location),
      };

    case 'realLiteral':
      return {
        type: 'RealLiteral',
        value: expr.value,
        loc: adaptLocation(expr.location),
      };

    case 'stringLiteral':
      return {
        type: 'StringLiteral',
        value: expr.value,
        loc: adaptLocation(expr.location),
      };

    case 'booleanLiteral':
      return {
        type: 'BooleanLiteral',
        value: expr.value,
        loc: adaptLocation(expr.location),
      };

    case 'timeLiteral':
      return {
        type: 'TimeLiteral',
        value: expr.raw,
        totalMs: parseTimeLiteralMs(expr.raw),
        loc: adaptLocation(expr.location),
      };

    case 'dateLiteral':
      return {
        type: 'DateLiteral',
        value: expr.raw,
        loc: adaptLocation(expr.location),
      };

    case 'binaryExpression':
      return {
        type: 'BinaryExpr',
        operator: expr.operator,
        left: adaptExpression(expr.left),
        right: adaptExpression(expr.right),
        loc: adaptLocation(expr.location),
      };

    case 'unaryExpression':
      return {
        type: 'UnaryExpr',
        operator: expr.operator,
        operand: adaptExpression(expr.operand),
        loc: adaptLocation(expr.location),
      };

    case 'functionCall':
      return {
        type: 'FunctionCall',
        name: expr.name,
        args: expr.args.map(adaptExpression),
        namedArgs: expr.namedArgs.map((na: NamedArgument) => ({
          name: na.name,
          value: adaptExpression(na.value),
        })),
        loc: adaptLocation(expr.location),
      };

    case 'arrayAccess':
      return {
        type: 'ArrayAccess',
        array: adaptExpression(expr.array),
        // Analyzer expects single index; use first
        index: expr.indices.length > 0
          ? adaptExpression(expr.indices[0]!)
          : { type: 'IntegerLiteral' as const, value: 0, loc: adaptLocation(expr.location) },
        loc: adaptLocation(expr.location),
      };

    case 'memberAccess':
      return {
        type: 'MemberAccess',
        object: adaptExpression(expr.object),
        member: expr.member,
        loc: adaptLocation(expr.location),
      };

    case 'deref':
      // Analyzer doesn't have deref; treat as the operand
      return adaptExpression(expr.operand);

    case 'parenthesized':
      return {
        type: 'ParenExpr',
        expr: adaptExpression(expr.expression),
        loc: adaptLocation(expr.location),
      };

    case 'hexLiteral':
    case 'octalLiteral':
    case 'binaryLiteral':
      return {
        type: 'IntegerLiteral',
        value: expr.value,
        loc: adaptLocation(expr.location),
      };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function adaptLocation(loc: SourceLocation): ASTLocation {
  return {
    startLine: loc.startLine,
    startCol: loc.startCol,
    endLine: loc.endLine,
    endCol: loc.endCol,
  };
}

function adaptCaseLabel(label: CaseLabel): AnalyzerExpression {
  if (label.kind === 'single') {
    return adaptExpression(label.value);
  }
  // Range label: use lower bound as the expression for type checking
  return adaptExpression(label.lower);
}

/**
 * Extract the type name string from a parser TypeNode.
 */
function resolveTypeNodeName(typeNode: TypeNode): string {
  switch (typeNode.kind) {
    case 'elementaryType':
      return typeNode.name;
    case 'namedType':
      return typeNode.name;
    case 'arrayType':
      return `ARRAY OF ${resolveTypeNodeName(typeNode.elementType)}`;
    case 'stringType':
      return typeNode.baseType;
    case 'structType':
      return 'STRUCT';
    case 'enumType':
      return 'ENUM';
    case 'subrangeType':
      return resolveTypeNodeName(typeNode.baseType);
  }
}

/**
 * Extract a numeric literal value from an expression (for array bounds).
 */
function extractLiteralValue(expr: ParserExpression): number | undefined {
  switch (expr.kind) {
    case 'integerLiteral':
      return expr.value;
    case 'hexLiteral':
    case 'octalLiteral':
    case 'binaryLiteral':
      return expr.value;
    case 'unaryExpression':
      if (expr.operator === '-') {
        const val = extractLiteralValue(expr.operand);
        return val !== undefined ? -val : undefined;
      }
      return extractLiteralValue(expr.operand);
    default:
      return undefined;
  }
}

/**
 * Parse a TIME literal string to milliseconds (rough estimate).
 * Examples: T#1s, T#500ms, T#1h30m, TIME#2d5h
 */
function parseTimeLiteralMs(raw: string): number {
  let ms = 0;
  const clean = raw.replace(/^(T|TIME)#/i, '');
  const dMatch = clean.match(/(\d+(?:\.\d+)?)d/i);
  const hMatch = clean.match(/(\d+(?:\.\d+)?)h/i);
  const mMatch = clean.match(/(\d+(?:\.\d+)?)m(?!s)/i);
  const sMatch = clean.match(/(\d+(?:\.\d+)?)s(?!$|\d)/i) || clean.match(/(\d+(?:\.\d+)?)s$/i);
  const msMatch = clean.match(/(\d+(?:\.\d+)?)ms/i);

  if (dMatch) ms += parseFloat(dMatch[1]!) * 86400000;
  if (hMatch) ms += parseFloat(hMatch[1]!) * 3600000;
  if (mMatch) ms += parseFloat(mMatch[1]!) * 60000;
  if (sMatch) ms += parseFloat(sMatch[1]!) * 1000;
  if (msMatch) ms += parseFloat(msMatch[1]!);

  return ms;
}
