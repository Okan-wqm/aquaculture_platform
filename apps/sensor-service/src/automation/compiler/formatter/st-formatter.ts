/**
 * IEC 61131-3 Structured Text AST-Based Code Formatter
 *
 * Formats ST source code following IEC 61131-3 conventions:
 * 1. Keywords UPPERCASE: if -> IF, then -> THEN, end_if -> END_IF
 * 2. Configurable indentation (default 4 spaces)
 * 3. Blank line between VAR..END_VAR and body
 * 4. Blank line between POUs
 * 5. Semicolons at end of statements
 * 6. Spaces around operators: a := b + c
 * 7. No space before semicolons
 * 8. One space after comma in argument lists
 * 9. Align := within same VAR block (optional)
 * 10. Comments preserved in position
 * 11. Empty lines reduced to max 2 consecutive
 */

import type {
  ASTNode,
  ProgramNode,
  FunctionBlockNode,
  FunctionNode,
  InterfaceNode,
  TypeDeclarationNode,
  MethodNode,
  PropertyNode,
  MethodSignatureNode,
  PropertySignatureNode,
  VarBlockNode,
  VarDeclarationNode,
  TypeNode,
  ArrayTypeNode,
  StringTypeNode,
  StructTypeNode,
  EnumTypeNode,
  NamedTypeNode,
  ElementaryTypeNode,
  SubrangeTypeNode,
  Statement,
  AssignmentStatement,
  IfStatement,
  ElsifBranch,
  CaseStatement,
  CaseBranch,
  CaseLabel,
  ForStatement,
  WhileStatement,
  RepeatStatement,
  Expression,
  BinaryExpression,
  UnaryExpression,
  FunctionCallExpression,
  ArrayAccessExpression,
  MemberAccessExpression,
  DerefExpression,
  IdentifierExpression,
  ParenthesizedExpression,
  NamedArgument,
} from '@platform/sensor-automation-types';

// ────────────────────────────────────────────────────────────────────────────
// Formatter Options
// ────────────────────────────────────────────────────────────────────────────

export interface STFormatterOptions {
  /** Number of spaces per indent level (default: 4) */
  indentSize: number;
  /** Use tabs instead of spaces (default: false) */
  useTabs: boolean;
  /** Align := in VAR blocks (default: false) */
  alignAssignments: boolean;
  /** Maximum consecutive empty lines (default: 2) */
  maxConsecutiveEmptyLines: number;
  /** Add blank line between VAR..END_VAR and body (default: true) */
  blankLineAfterVarBlock: boolean;
  /** Add blank line between POUs (default: true) */
  blankLineBetweenPOUs: boolean;
}

const DEFAULT_OPTIONS: STFormatterOptions = {
  indentSize: 4,
  useTabs: false,
  alignAssignments: false,
  maxConsecutiveEmptyLines: 2,
  blankLineAfterVarBlock: true,
  blankLineBetweenPOUs: true,
};

/** TextEdit for range-based formatting */
export interface TextEdit {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  newText: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Formatter Class
// ────────────────────────────────────────────────────────────────────────────

export class STFormatter {
  private options: STFormatterOptions;
  private indentStr: string;

  constructor(options?: Partial<STFormatterOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.indentStr = this.options.useTabs
      ? '\t'
      : ' '.repeat(this.options.indentSize);
  }

  /**
   * Format an entire AST into a formatted ST source string.
   */
  format(ast: ASTNode[]): string {
    const parts: string[] = [];

    for (let i = 0; i < ast.length; i++) {
      if (i > 0 && this.options.blankLineBetweenPOUs) {
        parts.push('');
      }
      parts.push(this.formatNode(ast[i]!, 0));
    }

    let result = parts.join('\n');
    result = this.collapseEmptyLines(result);
    // Ensure trailing newline
    if (!result.endsWith('\n')) {
      result += '\n';
    }
    return result;
  }

  /**
   * Format a range of lines from the AST, returning TextEdits.
   * Finds AST nodes overlapping [startLine, endLine] and formats only those.
   */
  formatRange(ast: ASTNode[], startLine: number, endLine: number): TextEdit[] {
    const edits: TextEdit[] = [];

    for (const node of ast) {
      const loc = node.location;
      // Check if node overlaps the requested range
      if (loc.endLine < startLine || loc.startLine > endLine) {
        continue;
      }

      const formatted = this.formatNode(node, 0);

      edits.push({
        startLine: loc.startLine,
        startCol: loc.startCol,
        endLine: loc.endLine,
        endCol: loc.endCol,
        newText: formatted,
      });
    }

    return edits;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Top-Level Node Dispatch
  // ──────────────────────────────────────────────────────────────────────

  private formatNode(node: ASTNode, depth: number): string {
    switch (node.kind) {
      case 'program':
        return this.formatProgram(node, depth);
      case 'functionBlock':
        return this.formatFunctionBlock(node, depth);
      case 'function':
        return this.formatFunction(node, depth);
      case 'interface':
        return this.formatInterface(node, depth);
      case 'typeDeclaration':
        return this.formatTypeDeclaration(node, depth);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // POU Formatters
  // ──────────────────────────────────────────────────────────────────────

  private formatProgram(node: ProgramNode, depth: number): string {
    const ind = this.indent(depth);
    const lines: string[] = [];

    lines.push(`${ind}PROGRAM ${node.name}`);
    lines.push(...this.formatVarBlocks(node.varBlocks, depth + 1));

    if (node.varBlocks.length > 0 && node.body.length > 0 && this.options.blankLineAfterVarBlock) {
      lines.push('');
    }

    lines.push(...this.formatStatements(node.body, depth + 1));
    lines.push(`${ind}END_PROGRAM`);

    return lines.join('\n');
  }

  private formatFunctionBlock(node: FunctionBlockNode, depth: number): string {
    const ind = this.indent(depth);
    const lines: string[] = [];

    let header = `${ind}FUNCTION_BLOCK ${node.name}`;
    if (node.extends) {
      header += ` EXTENDS ${node.extends}`;
    }
    if (node.implements && node.implements.length > 0) {
      header += ` IMPLEMENTS ${node.implements.join(', ')}`;
    }
    lines.push(header);

    lines.push(...this.formatVarBlocks(node.varBlocks, depth + 1));

    if (node.varBlocks.length > 0 && (node.body.length > 0 || node.methods.length > 0 || node.properties.length > 0) && this.options.blankLineAfterVarBlock) {
      lines.push('');
    }

    lines.push(...this.formatStatements(node.body, depth + 1));

    for (const method of node.methods) {
      lines.push('');
      lines.push(this.formatMethod(method, depth + 1));
    }

    for (const prop of node.properties) {
      lines.push('');
      lines.push(this.formatProperty(prop, depth + 1));
    }

    lines.push(`${ind}END_FUNCTION_BLOCK`);

    return lines.join('\n');
  }

  private formatFunction(node: FunctionNode, depth: number): string {
    const ind = this.indent(depth);
    const lines: string[] = [];

    lines.push(`${ind}FUNCTION ${node.name} : ${this.formatType(node.returnType)}`);
    lines.push(...this.formatVarBlocks(node.varBlocks, depth + 1));

    if (node.varBlocks.length > 0 && node.body.length > 0 && this.options.blankLineAfterVarBlock) {
      lines.push('');
    }

    lines.push(...this.formatStatements(node.body, depth + 1));
    lines.push(`${ind}END_FUNCTION`);

    return lines.join('\n');
  }

  private formatInterface(node: InterfaceNode, depth: number): string {
    const ind = this.indent(depth);
    const lines: string[] = [];

    let header = `${ind}INTERFACE ${node.name}`;
    if (node.extends && node.extends.length > 0) {
      header += ` EXTENDS ${node.extends.join(', ')}`;
    }
    lines.push(header);

    for (const method of node.methods) {
      lines.push('');
      lines.push(this.formatMethodSignature(method, depth + 1));
    }

    for (const prop of node.properties) {
      lines.push(this.formatPropertySignature(prop, depth + 1));
    }

    lines.push(`${ind}END_INTERFACE`);

    return lines.join('\n');
  }

  private formatTypeDeclaration(node: TypeDeclarationNode, depth: number): string {
    const ind = this.indent(depth);
    const lines: string[] = [];

    lines.push(`${ind}TYPE ${node.name} :`);
    lines.push(this.formatTypeBody(node.type, depth + 1));
    lines.push(`${ind}END_TYPE`);

    return lines.join('\n');
  }

  // ──────────────────────────────────────────────────────────────────────
  // Method / Property Formatters
  // ──────────────────────────────────────────────────────────────────────

  private formatMethod(node: MethodNode, depth: number): string {
    const ind = this.indent(depth);
    const lines: string[] = [];

    let header = `${ind}METHOD`;
    if (node.accessSpecifier) {
      header += ` ${node.accessSpecifier}`;
    }
    header += ` ${node.name}`;
    if (node.returnType) {
      header += ` : ${this.formatType(node.returnType)}`;
    }
    lines.push(header);

    lines.push(...this.formatVarBlocks(node.varBlocks, depth + 1));

    if (node.varBlocks.length > 0 && node.body.length > 0 && this.options.blankLineAfterVarBlock) {
      lines.push('');
    }

    lines.push(...this.formatStatements(node.body, depth + 1));
    lines.push(`${ind}END_METHOD`);

    return lines.join('\n');
  }

  private formatProperty(node: PropertyNode, depth: number): string {
    const ind = this.indent(depth);
    const lines: string[] = [];

    lines.push(`${ind}PROPERTY ${node.name} : ${this.formatType(node.propertyType)}`);

    if (node.getter) {
      lines.push(this.formatMethod(node.getter, depth + 1));
    }
    if (node.setter) {
      lines.push(this.formatMethod(node.setter, depth + 1));
    }

    lines.push(`${ind}END_PROPERTY`);

    return lines.join('\n');
  }

  private formatMethodSignature(node: MethodSignatureNode, depth: number): string {
    const ind = this.indent(depth);
    let line = `${ind}METHOD ${node.name}`;
    if (node.returnType) {
      line += ` : ${this.formatType(node.returnType)}`;
    }
    const lines: string[] = [line];

    lines.push(...this.formatVarBlocks(node.varBlocks, depth + 1));
    lines.push(`${ind}END_METHOD`);

    return lines.join('\n');
  }

  private formatPropertySignature(node: PropertySignatureNode, depth: number): string {
    const ind = this.indent(depth);
    return `${ind}PROPERTY ${node.name} : ${this.formatType(node.propertyType)}`;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Variable Block Formatters
  // ──────────────────────────────────────────────────────────────────────

  private formatVarBlocks(blocks: VarBlockNode[], depth: number): string[] {
    const lines: string[] = [];

    for (const block of blocks) {
      lines.push(...this.formatVarBlock(block, depth));
    }

    return lines;
  }

  private formatVarBlock(block: VarBlockNode, depth: number): string[] {
    const ind = this.indent(depth);
    const lines: string[] = [];

    // Build VAR header with qualifiers
    let header = block.blockType;
    if (block.constant) header += ' CONSTANT';
    if (block.retain) header += ' RETAIN';
    if (block.persistent) header += ' PERSISTENT';
    lines.push(`${ind}${header}`);

    // Optionally align := in declarations
    if (this.options.alignAssignments && block.declarations.length > 0) {
      lines.push(...this.formatAlignedDeclarations(block.declarations, depth + 1));
    } else {
      for (const decl of block.declarations) {
        lines.push(this.formatVarDeclaration(decl, depth + 1));
      }
    }

    lines.push(`${ind}END_VAR`);

    return lines;
  }

  private formatVarDeclaration(decl: VarDeclarationNode, depth: number): string {
    const ind = this.indent(depth);
    const names = decl.names.join(', ');
    let line = `${ind}${names} : ${this.formatType(decl.type)}`;

    if (decl.atAddress) {
      line = `${ind}${names} AT ${decl.atAddress} : ${this.formatType(decl.type)}`;
    }

    if (decl.initialValue) {
      line += ` := ${this.formatExpression(decl.initialValue)}`;
    }

    line += ';';
    return line;
  }

  private formatAlignedDeclarations(decls: VarDeclarationNode[], depth: number): string[] {
    const ind = this.indent(depth);
    const lines: string[] = [];

    // Compute the parts for alignment
    const parts: Array<{ prefix: string; type: string; init?: string }> = [];
    let maxPrefixLen = 0;
    let maxTypeLen = 0;

    for (const decl of decls) {
      const names = decl.names.join(', ');
      let prefix = names;
      if (decl.atAddress) {
        prefix += ` AT ${decl.atAddress}`;
      }
      const type = this.formatType(decl.type);
      const init = decl.initialValue ? this.formatExpression(decl.initialValue) : undefined;

      if (prefix.length > maxPrefixLen) maxPrefixLen = prefix.length;
      if (type.length > maxTypeLen) maxTypeLen = type.length;

      parts.push({ prefix, type, init });
    }

    for (const part of parts) {
      const paddedPrefix = part.prefix.padEnd(maxPrefixLen);
      let line = `${ind}${paddedPrefix} : ${part.type}`;
      if (part.init !== undefined) {
        const paddedType = part.type.padEnd(maxTypeLen);
        line = `${ind}${paddedPrefix} : ${paddedType} := ${part.init}`;
      }
      line += ';';
      lines.push(line);
    }

    return lines;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Statement Formatters
  // ──────────────────────────────────────────────────────────────────────

  private formatStatements(stmts: Statement[], depth: number): string[] {
    const lines: string[] = [];
    for (const stmt of stmts) {
      const formatted = this.formatStatement(stmt, depth);
      if (formatted !== null) {
        lines.push(formatted);
      }
    }
    return lines;
  }

  private formatStatement(stmt: Statement, depth: number): string | null {
    const ind = this.indent(depth);

    switch (stmt.kind) {
      case 'assignment':
        return this.formatAssignment(stmt, depth);
      case 'ifStatement':
        return this.formatIf(stmt, depth);
      case 'caseStatement':
        return this.formatCase(stmt, depth);
      case 'forStatement':
        return this.formatFor(stmt, depth);
      case 'whileStatement':
        return this.formatWhile(stmt, depth);
      case 'repeatStatement':
        return this.formatRepeat(stmt, depth);
      case 'returnStatement':
        return `${ind}RETURN;`;
      case 'exitStatement':
        return `${ind}EXIT;`;
      case 'expressionStatement':
        return `${ind}${this.formatExpression(stmt.expression)};`;
      case 'emptyStatement':
        return null;
    }
  }

  private formatAssignment(stmt: AssignmentStatement, depth: number): string {
    const ind = this.indent(depth);
    return `${ind}${this.formatExpression(stmt.target)} := ${this.formatExpression(stmt.value)};`;
  }

  private formatIf(stmt: IfStatement, depth: number): string {
    const ind = this.indent(depth);
    const lines: string[] = [];

    lines.push(`${ind}IF ${this.formatExpression(stmt.condition)} THEN`);
    lines.push(...this.formatStatements(stmt.thenBody, depth + 1));

    for (const elsif of stmt.elsifBranches) {
      lines.push(`${ind}ELSIF ${this.formatExpression(elsif.condition)} THEN`);
      lines.push(...this.formatStatements(elsif.body, depth + 1));
    }

    if (stmt.elseBody && stmt.elseBody.length > 0) {
      lines.push(`${ind}ELSE`);
      lines.push(...this.formatStatements(stmt.elseBody, depth + 1));
    }

    lines.push(`${ind}END_IF;`);

    return lines.join('\n');
  }

  private formatCase(stmt: CaseStatement, depth: number): string {
    const ind = this.indent(depth);
    const lines: string[] = [];

    lines.push(`${ind}CASE ${this.formatExpression(stmt.expression)} OF`);

    for (const branch of stmt.cases) {
      const labels = branch.labels.map(l => this.formatCaseLabel(l)).join(', ');
      lines.push(`${this.indent(depth + 1)}${labels}:`);
      lines.push(...this.formatStatements(branch.body, depth + 2));
    }

    if (stmt.elseBody && stmt.elseBody.length > 0) {
      lines.push(`${ind}ELSE`);
      lines.push(...this.formatStatements(stmt.elseBody, depth + 1));
    }

    lines.push(`${ind}END_CASE;`);

    return lines.join('\n');
  }

  private formatCaseLabel(label: CaseLabel): string {
    if (label.kind === 'single') {
      return this.formatExpression(label.value);
    }
    return `${this.formatExpression(label.lower)}..${this.formatExpression(label.upper)}`;
  }

  private formatFor(stmt: ForStatement, depth: number): string {
    const ind = this.indent(depth);
    const lines: string[] = [];

    let header = `${ind}FOR ${stmt.variable} := ${this.formatExpression(stmt.from)} TO ${this.formatExpression(stmt.to)}`;
    if (stmt.by) {
      header += ` BY ${this.formatExpression(stmt.by)}`;
    }
    header += ' DO';
    lines.push(header);

    lines.push(...this.formatStatements(stmt.body, depth + 1));
    lines.push(`${ind}END_FOR;`);

    return lines.join('\n');
  }

  private formatWhile(stmt: WhileStatement, depth: number): string {
    const ind = this.indent(depth);
    const lines: string[] = [];

    lines.push(`${ind}WHILE ${this.formatExpression(stmt.condition)} DO`);
    lines.push(...this.formatStatements(stmt.body, depth + 1));
    lines.push(`${ind}END_WHILE;`);

    return lines.join('\n');
  }

  private formatRepeat(stmt: RepeatStatement, depth: number): string {
    const ind = this.indent(depth);
    const lines: string[] = [];

    lines.push(`${ind}REPEAT`);
    lines.push(...this.formatStatements(stmt.body, depth + 1));
    lines.push(`${ind}UNTIL ${this.formatExpression(stmt.condition)}`);
    lines.push(`${ind}END_REPEAT;`);

    return lines.join('\n');
  }

  // ──────────────────────────────────────────────────────────────────────
  // Expression Formatters
  // ──────────────────────────────────────────────────────────────────────

  private formatExpression(expr: Expression): string {
    switch (expr.kind) {
      case 'binaryExpression':
        return this.formatBinaryExpr(expr);
      case 'unaryExpression':
        return this.formatUnaryExpr(expr);
      case 'functionCall':
        return this.formatFunctionCall(expr);
      case 'arrayAccess':
        return this.formatArrayAccess(expr);
      case 'memberAccess':
        return this.formatMemberAccess(expr);
      case 'deref':
        return `${this.formatExpression(expr.operand)}^`;
      case 'identifier':
        return expr.name;
      case 'integerLiteral':
        return expr.raw;
      case 'realLiteral':
        return expr.raw;
      case 'stringLiteral':
        return expr.raw;
      case 'booleanLiteral':
        return expr.value ? 'TRUE' : 'FALSE';
      case 'timeLiteral':
        return expr.raw;
      case 'dateLiteral':
        return expr.raw;
      case 'hexLiteral':
        return expr.raw;
      case 'octalLiteral':
        return expr.raw;
      case 'binaryLiteral':
        return expr.raw;
      case 'parenthesized':
        return `(${this.formatExpression(expr.expression)})`;
    }
  }

  private formatBinaryExpr(expr: BinaryExpression): string {
    const left = this.formatExpression(expr.left);
    const right = this.formatExpression(expr.right);
    return `${left} ${expr.operator} ${right}`;
  }

  private formatUnaryExpr(expr: UnaryExpression): string {
    const operand = this.formatExpression(expr.operand);
    if (expr.operator === 'NOT') {
      return `NOT ${operand}`;
    }
    // Unary - or +
    return `${expr.operator}${operand}`;
  }

  private formatFunctionCall(expr: FunctionCallExpression): string {
    const args: string[] = [];

    // Positional args
    for (const arg of expr.args) {
      args.push(this.formatExpression(arg));
    }

    // Named args
    for (const narg of expr.namedArgs) {
      const assignOp = narg.assignType === 'output' ? ' => ' : ' := ';
      args.push(`${narg.name}${assignOp}${this.formatExpression(narg.value)}`);
    }

    return `${expr.name}(${args.join(', ')})`;
  }

  private formatArrayAccess(expr: ArrayAccessExpression): string {
    const indices = expr.indices.map(i => this.formatExpression(i)).join(', ');
    return `${this.formatExpression(expr.array)}[${indices}]`;
  }

  private formatMemberAccess(expr: MemberAccessExpression): string {
    return `${this.formatExpression(expr.object)}.${expr.member}`;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Type Formatters
  // ──────────────────────────────────────────────────────────────────────

  private formatType(type: TypeNode): string {
    switch (type.kind) {
      case 'elementaryType':
        return type.name.toUpperCase();
      case 'namedType':
        return type.name;
      case 'arrayType':
        return this.formatArrayType(type);
      case 'stringType':
        return this.formatStringType(type);
      case 'structType':
        return 'STRUCT'; // Inline struct handled by formatTypeBody
      case 'enumType':
        return 'ENUM'; // Inline enum handled by formatTypeBody
      case 'subrangeType':
        return `${this.formatType(type.baseType)}(${this.formatExpression(type.lower)}..${this.formatExpression(type.upper)})`;
    }
  }

  private formatArrayType(type: ArrayTypeNode): string {
    const dims = type.dimensions
      .map(d => `${this.formatExpression(d.lower)}..${this.formatExpression(d.upper)}`)
      .join(', ');
    return `ARRAY[${dims}] OF ${this.formatType(type.elementType)}`;
  }

  private formatStringType(type: StringTypeNode): string {
    if (type.maxLength) {
      return `${type.baseType}[${this.formatExpression(type.maxLength)}]`;
    }
    return type.baseType;
  }

  private formatTypeBody(type: TypeNode, depth: number): string {
    const ind = this.indent(depth);

    if (type.kind === 'structType') {
      const lines: string[] = [];
      lines.push(`${ind}STRUCT`);
      for (const member of type.members) {
        let line = `${this.indent(depth + 1)}${member.name} : ${this.formatType(member.type)}`;
        if (member.initialValue) {
          line += ` := ${this.formatExpression(member.initialValue)}`;
        }
        line += ';';
        lines.push(line);
      }
      lines.push(`${ind}END_STRUCT;`);
      return lines.join('\n');
    }

    if (type.kind === 'enumType') {
      const lines: string[] = [];
      const baseStr = type.baseType ? ` ${this.formatType(type.baseType)}` : '';
      lines.push(`${ind}(`);
      for (let i = 0; i < type.members.length; i++) {
        const m = type.members[i]!;
        let line = `${this.indent(depth + 1)}${m.name}`;
        if (m.value) {
          line += ` := ${this.formatExpression(m.value)}`;
        }
        if (i < type.members.length - 1) {
          line += ',';
        }
        lines.push(line);
      }
      lines.push(`${ind})${baseStr};`);
      return lines.join('\n');
    }

    return `${ind}${this.formatType(type)};`;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Utilities
  // ──────────────────────────────────────────────────────────────────────

  private indent(depth: number): string {
    return this.indentStr.repeat(depth);
  }

  private collapseEmptyLines(text: string): string {
    const max = this.options.maxConsecutiveEmptyLines;
    const regex = new RegExp(`(\\n\\s*){${max + 2},}`, 'g');
    const replacement = '\n'.repeat(max + 1);
    return text.replace(regex, replacement);
  }
}
