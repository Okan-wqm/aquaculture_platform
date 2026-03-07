/**
 * IEC 61131-3 Structured Text Recursive Descent Parser
 *
 * Converts a token stream from st-lexer into an AST.
 *
 * Features:
 * - Full IEC 61131-3 construct coverage (PROGRAM, FUNCTION_BLOCK, FUNCTION,
 *   METHOD, PROPERTY, INTERFACE, TYPE declarations)
 * - Pratt-style operator precedence parsing for expressions
 * - Error recovery: continues parsing after errors (skip to semicolon/END_*)
 * - Security: max nesting depth (50), max error count (100), token limit (500K)
 * - Performance target: 100KB source in < 500ms
 */

import { Token, TokenType } from '../lexer/st-tokens';
import {
  type ASTNode,
  type ProgramNode,
  type FunctionBlockNode,
  type FunctionNode,
  type MethodNode,
  type PropertyNode,
  type InterfaceNode,
  type MethodSignatureNode,
  type PropertySignatureNode,
  type VarBlockNode,
  type VarBlockKind,
  type VarDeclarationNode,
  type TypeNode,
  type ArrayTypeNode,
  type ArrayDimension,
  type StructTypeNode,
  type StructMemberNode,
  type EnumTypeNode,
  type EnumMemberNode,
  type TypeDeclarationNode,
  type Statement,
  type AssignmentStatement,
  type IfStatement,
  type ElsifBranch,
  type CaseStatement,
  type CaseBranch,
  type CaseLabel,
  type ForStatement,
  type WhileStatement,
  type RepeatStatement,
  type Expression,
  type BinaryOperator,
  type UnaryOperator,
  type FunctionCallExpression,
  type NamedArgument,
  type SourceLocation,
  type ParseResult,
  type ParseError,
} from './st-ast';
import { ParserErrorCode, RecoveryStrategy, createParseError } from './st-errors';

// ────────────────────────────────────────────────────────────────────────────
// Parser Options
// ────────────────────────────────────────────────────────────────────────────

export interface ParserOptions {
  maxDepth?: number;
  maxErrors?: number;
  maxTokenCount?: number;
  timeoutMs?: number;
}

const DEFAULT_OPTIONS: Required<ParserOptions> = {
  maxDepth: 50,
  maxErrors: 100,
  maxTokenCount: 500_000,
  timeoutMs: 5_000,
};

// ────────────────────────────────────────────────────────────────────────────
// Operator Precedence Table (Pratt parsing)
// Lower number = lower precedence (binds less tightly)
// ────────────────────────────────────────────────────────────────────────────

function getPrecedence(type: TokenType): number {
  switch (type) {
    case TokenType.OR:    return 1;
    case TokenType.XOR:   return 2;
    case TokenType.AND:   return 3;
    case TokenType.EQ:
    case TokenType.NEQ:   return 4;
    case TokenType.LT:
    case TokenType.GT:
    case TokenType.LE:
    case TokenType.GE:    return 5;
    case TokenType.PLUS:
    case TokenType.MINUS:  return 6;
    case TokenType.STAR:
    case TokenType.SLASH:
    case TokenType.MOD:    return 7;
    case TokenType.POWER:  return 8;
    case TokenType.SHL:
    case TokenType.SHR:
    case TokenType.ROL:
    case TokenType.ROR:    return 7; // same as multiplicative
    default:               return 0;
  }
}

function tokenToBinaryOp(type: TokenType): BinaryOperator | null {
  switch (type) {
    case TokenType.OR:    return 'OR';
    case TokenType.XOR:   return 'XOR';
    case TokenType.AND:   return 'AND';
    case TokenType.EQ:    return '=';
    case TokenType.NEQ:   return '<>';
    case TokenType.LT:    return '<';
    case TokenType.GT:    return '>';
    case TokenType.LE:    return '<=';
    case TokenType.GE:    return '>=';
    case TokenType.PLUS:  return '+';
    case TokenType.MINUS: return '-';
    case TokenType.STAR:  return '*';
    case TokenType.SLASH: return '/';
    case TokenType.MOD:   return 'MOD';
    case TokenType.POWER: return '**';
    case TokenType.SHL:   return 'SHL';
    case TokenType.SHR:   return 'SHR';
    case TokenType.ROL:   return 'ROL';
    case TokenType.ROR:   return 'ROR';
    default:              return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helper: set of data type token types
// ────────────────────────────────────────────────────────────────────────────

const DATA_TYPE_TOKENS = new Set<TokenType>([
  TokenType.BOOL, TokenType.BYTE, TokenType.WORD, TokenType.DWORD, TokenType.LWORD,
  TokenType.SINT, TokenType.INT, TokenType.DINT, TokenType.LINT,
  TokenType.USINT, TokenType.UINT, TokenType.UDINT, TokenType.ULINT,
  TokenType.REAL, TokenType.LREAL,
  TokenType.STRING, TokenType.WSTRING,
  TokenType.TIME, TokenType.DATE, TokenType.TIME_OF_DAY, TokenType.TOD,
  TokenType.DATE_AND_TIME, TokenType.DT,
]);

const VAR_BLOCK_TOKENS = new Set<TokenType>([
  TokenType.VAR, TokenType.VAR_INPUT, TokenType.VAR_OUTPUT,
  TokenType.VAR_IN_OUT, TokenType.VAR_GLOBAL, TokenType.VAR_TEMP,
  TokenType.VAR_EXTERNAL,
]);

const STATEMENT_START_TOKENS = new Set<TokenType>([
  TokenType.IDENTIFIER,
  TokenType.IF, TokenType.CASE, TokenType.FOR, TokenType.WHILE,
  TokenType.REPEAT, TokenType.RETURN, TokenType.EXIT,
  TokenType.SEMICOLON,
]);

const POU_END_TOKENS = new Set<TokenType>([
  TokenType.END_PROGRAM, TokenType.END_FUNCTION, TokenType.END_FUNCTION_BLOCK,
  TokenType.END_METHOD, TokenType.END_PROPERTY, TokenType.END_INTERFACE,
]);

// ────────────────────────────────────────────────────────────────────────────
// Parser Class
// ────────────────────────────────────────────────────────────────────────────

export class STParser {
  private tokens: Token[];
  private pos: number = 0;
  private errors: ParseError[] = [];
  private depth: number = 0;
  private options: Required<ParserOptions>;
  private startTime: number;
  private halted: boolean = false;

  constructor(tokens: Token[], options?: ParserOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };

    // Filter out whitespace, newline, and comment tokens
    this.tokens = tokens.filter(
      (t) =>
        t.type !== TokenType.WHITESPACE &&
        t.type !== TokenType.NEWLINE &&
        t.type !== TokenType.COMMENT,
    );

    // Security: token count limit
    if (this.tokens.length > this.options.maxTokenCount) {
      this.errors.push(
        createParseError(
          ParserErrorCode.TOKEN_LIMIT_EXCEEDED,
          `Token count ${this.tokens.length} exceeds limit of ${this.options.maxTokenCount}`,
          1, 1,
        ),
      );
      this.halted = true;
    }

    this.startTime = Date.now();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Public API
  // ══════════════════════════════════════════════════════════════════════════

  parse(): ParseResult {
    if (this.halted) {
      return { ast: [], errors: this.errors };
    }

    const ast = this.parseCompilationUnit();
    return { ast, errors: this.errors };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Token Navigation
  // ══════════════════════════════════════════════════════════════════════════

  private peek(): Token {
    return this.tokens[this.pos] ?? this.eofToken();
  }

  private peekAt(offset: number): Token {
    return this.tokens[this.pos + offset] ?? this.eofToken();
  }

  private advance(): Token {
    const tok = this.peek();
    if (tok.type !== TokenType.EOF) {
      this.pos++;
    }
    return tok;
  }

  private match(...types: TokenType[]): boolean {
    if (types.includes(this.peek().type)) {
      this.advance();
      return true;
    }
    return false;
  }

  private check(type: TokenType): boolean {
    return this.peek().type === type;
  }

  private checkAny(...types: TokenType[]): boolean {
    return types.includes(this.peek().type);
  }

  private expect(type: TokenType, errorCode?: string, errorMsg?: string): Token {
    const tok = this.peek();
    if (tok.type === type) {
      return this.advance();
    }
    const code = errorCode ?? ParserErrorCode.UNEXPECTED_TOKEN;
    const msg = errorMsg ?? `Expected ${type}, got ${tok.type} ('${tok.value}')`;
    this.addError(code, msg, tok);
    // Return a synthetic token so parsing can continue
    return { type, value: '', line: tok.line, col: tok.col, offset: tok.offset, length: 0 };
  }

  private previous(): Token {
    return this.tokens[this.pos - 1] ?? this.eofToken();
  }

  private eofToken(): Token {
    const last = this.tokens[this.tokens.length - 1];
    if (last && last.type === TokenType.EOF) return last;
    return { type: TokenType.EOF, value: '', line: 1, col: 1, offset: 0, length: 0 };
  }

  private isAtEnd(): boolean {
    return this.peek().type === TokenType.EOF;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Error Management
  // ══════════════════════════════════════════════════════════════════════════

  private addError(code: string, message: string, token: Token, hint?: string): void {
    if (this.errors.length >= this.options.maxErrors) {
      if (!this.halted) {
        this.errors.push(
          createParseError(
            ParserErrorCode.MAX_ERRORS_EXCEEDED,
            `Too many errors (limit: ${this.options.maxErrors}). Parsing stopped.`,
            token.line, token.col,
          ),
        );
        this.halted = true;
      }
      return;
    }
    this.errors.push(
      createParseError(
        code,
        message,
        token.line,
        token.col,
        token.line,
        token.col + Math.max(token.length, 1),
        hint,
      ),
    );
  }

  private checkTimeout(): void {
    if (Date.now() - this.startTime > this.options.timeoutMs) {
      this.errors.push(
        createParseError(
          ParserErrorCode.PARSE_TIMEOUT,
          `Parse timeout exceeded (${this.options.timeoutMs}ms)`,
          this.peek().line, this.peek().col,
        ),
      );
      this.halted = true;
    }
  }

  private checkDepth(): void {
    if (this.depth > this.options.maxDepth) {
      this.addError(
        ParserErrorCode.MAX_NESTING_EXCEEDED,
        `Maximum nesting depth (${this.options.maxDepth}) exceeded`,
        this.peek(),
      );
      this.halted = true;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Error Recovery
  // ══════════════════════════════════════════════════════════════════════════

  private synchronize(strategy: RecoveryStrategy = RecoveryStrategy.SYNC_SEMICOLON): void {
    switch (strategy) {
      case RecoveryStrategy.SYNC_SEMICOLON:
        while (!this.isAtEnd() && !this.check(TokenType.SEMICOLON)) {
          if (STATEMENT_START_TOKENS.has(this.peek().type) || POU_END_TOKENS.has(this.peek().type)) return;
          this.advance();
        }
        if (this.check(TokenType.SEMICOLON)) this.advance();
        break;

      case RecoveryStrategy.SYNC_END:
        while (!this.isAtEnd()) {
          const t = this.peek().type;
          if (
            t === TokenType.END_IF || t === TokenType.END_FOR ||
            t === TokenType.END_WHILE || t === TokenType.END_REPEAT ||
            t === TokenType.END_CASE || POU_END_TOKENS.has(t)
          ) return;
          this.advance();
        }
        break;

      case RecoveryStrategy.SYNC_KEYWORD:
        while (!this.isAtEnd()) {
          if (STATEMENT_START_TOKENS.has(this.peek().type) || POU_END_TOKENS.has(this.peek().type)) return;
          if (VAR_BLOCK_TOKENS.has(this.peek().type)) return;
          this.advance();
        }
        break;

      case RecoveryStrategy.SYNC_VAR_END:
        while (!this.isAtEnd() && !this.check(TokenType.END_VAR)) {
          this.advance();
        }
        if (this.check(TokenType.END_VAR)) this.advance();
        break;

      case RecoveryStrategy.SYNC_POU_END:
        while (!this.isAtEnd() && !POU_END_TOKENS.has(this.peek().type)) {
          this.advance();
        }
        break;

      case RecoveryStrategy.NONE:
        break;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Location Helpers
  // ══════════════════════════════════════════════════════════════════════════

  private loc(startToken: Token, endToken?: Token): SourceLocation {
    const end = endToken ?? this.previous();
    return {
      startLine: startToken.line,
      startCol: startToken.col,
      endLine: end.line,
      endCol: end.col + Math.max(end.length, 1),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Compilation Unit
  // ══════════════════════════════════════════════════════════════════════════

  private parseCompilationUnit(): ASTNode[] {
    const nodes: ASTNode[] = [];

    while (!this.isAtEnd() && !this.halted) {
      this.checkTimeout();
      if (this.halted) break;

      const t = this.peek().type;

      try {
        if (t === TokenType.PROGRAM) {
          nodes.push(this.parseProgram());
        } else if (t === TokenType.FUNCTION_BLOCK) {
          nodes.push(this.parseFunctionBlock());
        } else if (t === TokenType.FUNCTION) {
          nodes.push(this.parseFunction());
        } else if (t === TokenType.INTERFACE) {
          nodes.push(this.parseInterface());
        } else if (t === TokenType.TYPE) {
          nodes.push(...this.parseTypeBlock());
        } else if (t === TokenType.EOF) {
          break;
        } else {
          this.addError(
            ParserErrorCode.UNEXPECTED_TOKEN,
            `Expected PROGRAM, FUNCTION_BLOCK, FUNCTION, INTERFACE, or TYPE, got ${t}`,
            this.peek(),
            'ST programs must start with a POU keyword',
          );
          this.advance();
        }
      } catch {
        // Recover from catastrophic errors in POU parsing
        this.synchronize(RecoveryStrategy.SYNC_POU_END);
        if (POU_END_TOKENS.has(this.peek().type)) {
          this.advance(); // consume the END_* token
        }
      }
    }

    return nodes;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // POU Parsers
  // ══════════════════════════════════════════════════════════════════════════

  private parseProgram(): ProgramNode {
    const start = this.expect(TokenType.PROGRAM);
    const nameToken = this.expect(TokenType.IDENTIFIER, ParserErrorCode.EXPECTED_IDENTIFIER, 'Expected program name');
    const name = nameToken.value;

    const varBlocks = this.parseVarBlocks();
    const body = this.parseStatementList(TokenType.END_PROGRAM);

    this.expect(TokenType.END_PROGRAM, ParserErrorCode.MISSING_END_PROGRAM, 'Expected END_PROGRAM');

    return {
      kind: 'program',
      name,
      varBlocks,
      body,
      location: this.loc(start),
    };
  }

  private parseFunctionBlock(): FunctionBlockNode {
    const start = this.expect(TokenType.FUNCTION_BLOCK);
    const nameToken = this.expect(TokenType.IDENTIFIER, ParserErrorCode.EXPECTED_IDENTIFIER, 'Expected function block name');
    const name = nameToken.value;

    // Optional: EXTENDS <name>
    let extendsName: string | undefined;
    if (this.peek().type === TokenType.IDENTIFIER && this.peek().value.toUpperCase() === 'EXTENDS') {
      this.advance();
      extendsName = this.expect(TokenType.IDENTIFIER).value;
    }

    // Optional: IMPLEMENTS <name>, <name>, ...
    let implementsList: string[] | undefined;
    if (this.peek().type === TokenType.IDENTIFIER && this.peek().value.toUpperCase() === 'IMPLEMENTS') {
      this.advance();
      implementsList = [this.expect(TokenType.IDENTIFIER).value];
      while (this.match(TokenType.COMMA)) {
        implementsList.push(this.expect(TokenType.IDENTIFIER).value);
      }
    }

    const varBlocks = this.parseVarBlocks();
    const methods: MethodNode[] = [];
    const properties: PropertyNode[] = [];
    const body: Statement[] = [];

    // Parse body: interleaved statements, methods, properties
    while (!this.isAtEnd() && !this.halted && !this.check(TokenType.END_FUNCTION_BLOCK)) {
      if (this.check(TokenType.METHOD)) {
        methods.push(this.parseMethod());
      } else if (this.check(TokenType.PROPERTY)) {
        properties.push(this.parseProperty());
      } else if (VAR_BLOCK_TOKENS.has(this.peek().type)) {
        // Additional var blocks after methods (rare but valid)
        varBlocks.push(this.parseVarBlock());
      } else {
        const stmt = this.parseStatement();
        if (stmt) body.push(stmt);
      }
    }

    this.expect(TokenType.END_FUNCTION_BLOCK, ParserErrorCode.MISSING_END_FUNCTION_BLOCK, 'Expected END_FUNCTION_BLOCK');

    return {
      kind: 'functionBlock',
      name,
      extends: extendsName,
      implements: implementsList,
      varBlocks,
      methods,
      properties,
      body,
      location: this.loc(start),
    };
  }

  private parseFunction(): FunctionNode {
    const start = this.expect(TokenType.FUNCTION);
    const nameToken = this.expect(TokenType.IDENTIFIER, ParserErrorCode.EXPECTED_IDENTIFIER, 'Expected function name');
    const name = nameToken.value;

    // Return type: FUNCTION myFunc : INT
    this.expect(TokenType.COLON, ParserErrorCode.EXPECTED_COLON, 'Expected : after function name for return type');
    const returnType = this.parseType();

    const varBlocks = this.parseVarBlocks();
    const body = this.parseStatementList(TokenType.END_FUNCTION);

    this.expect(TokenType.END_FUNCTION, ParserErrorCode.MISSING_END_FUNCTION, 'Expected END_FUNCTION');

    return {
      kind: 'function',
      name,
      returnType,
      varBlocks,
      body,
      location: this.loc(start),
    };
  }

  private parseMethod(): MethodNode {
    const start = this.expect(TokenType.METHOD);

    // Optional access specifier
    let accessSpecifier: MethodNode['accessSpecifier'];
    const accessWord = this.peek().value.toUpperCase();
    if (['PUBLIC', 'PRIVATE', 'PROTECTED', 'INTERNAL'].includes(accessWord) && this.peek().type === TokenType.IDENTIFIER) {
      accessSpecifier = accessWord as MethodNode['accessSpecifier'];
      this.advance();
    }

    const nameToken = this.expect(TokenType.IDENTIFIER, ParserErrorCode.EXPECTED_IDENTIFIER, 'Expected method name');
    const name = nameToken.value;

    // Optional return type: METHOD myMethod : BOOL
    let returnType: TypeNode | undefined;
    if (this.match(TokenType.COLON)) {
      returnType = this.parseType();
    }

    const varBlocks = this.parseVarBlocks();
    const body = this.parseStatementList(TokenType.END_METHOD);

    this.expect(TokenType.END_METHOD, ParserErrorCode.MISSING_END_METHOD, 'Expected END_METHOD');

    return {
      kind: 'method',
      name,
      returnType,
      accessSpecifier,
      varBlocks,
      body,
      location: this.loc(start),
    };
  }

  private parseProperty(): PropertyNode {
    const start = this.expect(TokenType.PROPERTY);
    const nameToken = this.expect(TokenType.IDENTIFIER, ParserErrorCode.EXPECTED_IDENTIFIER, 'Expected property name');
    const name = nameToken.value;

    this.expect(TokenType.COLON, ParserErrorCode.EXPECTED_COLON, 'Expected : after property name');
    const propertyType = this.parseType();

    // Parse GET / SET methods inside PROPERTY
    let getter: MethodNode | undefined;
    let setter: MethodNode | undefined;

    while (!this.isAtEnd() && !this.halted && !this.check(TokenType.END_PROPERTY)) {
      const w = this.peek().value.toUpperCase();
      if (w === 'GET' && this.peek().type === TokenType.IDENTIFIER) {
        const getStart = this.advance();
        const varBlocks = this.parseVarBlocks();
        const body = this.parseStatementList(TokenType.END_PROPERTY, TokenType.IDENTIFIER);
        // Check for END_GET (identifier)
        if (this.peek().type === TokenType.IDENTIFIER && this.peek().value.toUpperCase() === 'END_GET') {
          this.advance();
        }
        getter = { kind: 'method', name: 'GET', varBlocks, body, location: this.loc(getStart) };
      } else if (w === 'SET' && this.peek().type === TokenType.IDENTIFIER) {
        const setStart = this.advance();
        const varBlocks = this.parseVarBlocks();
        const body = this.parseStatementList(TokenType.END_PROPERTY, TokenType.IDENTIFIER);
        if (this.peek().type === TokenType.IDENTIFIER && this.peek().value.toUpperCase() === 'END_SET') {
          this.advance();
        }
        setter = { kind: 'method', name: 'SET', varBlocks, body, location: this.loc(setStart) };
      } else {
        this.addError(ParserErrorCode.UNEXPECTED_TOKEN, `Expected GET, SET, or END_PROPERTY, got '${this.peek().value}'`, this.peek());
        this.advance();
      }
    }

    this.expect(TokenType.END_PROPERTY, ParserErrorCode.MISSING_END_PROPERTY, 'Expected END_PROPERTY');

    return {
      kind: 'property',
      name,
      propertyType,
      getter,
      setter,
      location: this.loc(start),
    };
  }

  private parseInterface(): InterfaceNode {
    const start = this.expect(TokenType.INTERFACE);
    const nameToken = this.expect(TokenType.IDENTIFIER, ParserErrorCode.EXPECTED_IDENTIFIER, 'Expected interface name');
    const name = nameToken.value;

    // Optional: EXTENDS <name>, <name>
    let extendsList: string[] | undefined;
    if (this.peek().type === TokenType.IDENTIFIER && this.peek().value.toUpperCase() === 'EXTENDS') {
      this.advance();
      extendsList = [this.expect(TokenType.IDENTIFIER).value];
      while (this.match(TokenType.COMMA)) {
        extendsList.push(this.expect(TokenType.IDENTIFIER).value);
      }
    }

    const methods: MethodSignatureNode[] = [];
    const properties: PropertySignatureNode[] = [];

    while (!this.isAtEnd() && !this.halted && !this.check(TokenType.END_INTERFACE)) {
      if (this.check(TokenType.METHOD)) {
        const mStart = this.advance();
        const mName = this.expect(TokenType.IDENTIFIER).value;
        let retType: TypeNode | undefined;
        if (this.match(TokenType.COLON)) {
          retType = this.parseType();
        }
        const varBlocks = this.parseVarBlocks();
        this.expect(TokenType.END_METHOD, ParserErrorCode.MISSING_END_METHOD, 'Expected END_METHOD in interface');
        methods.push({
          kind: 'methodSignature',
          name: mName,
          returnType: retType,
          varBlocks,
          location: this.loc(mStart),
        });
      } else if (this.check(TokenType.PROPERTY)) {
        const pStart = this.advance();
        const pName = this.expect(TokenType.IDENTIFIER).value;
        this.expect(TokenType.COLON);
        const pType = this.parseType();
        this.expect(TokenType.END_PROPERTY, ParserErrorCode.MISSING_END_PROPERTY, 'Expected END_PROPERTY in interface');
        properties.push({
          kind: 'propertySignature',
          name: pName,
          propertyType: pType,
          location: this.loc(pStart),
        });
      } else {
        this.addError(ParserErrorCode.UNEXPECTED_TOKEN, `Expected METHOD or PROPERTY in interface, got '${this.peek().value}'`, this.peek());
        this.advance();
      }
    }

    this.expect(TokenType.END_INTERFACE, ParserErrorCode.MISSING_END_INTERFACE, 'Expected END_INTERFACE');

    return {
      kind: 'interface',
      name,
      extends: extendsList,
      methods,
      properties,
      location: this.loc(start),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Type Declarations (TYPE ... END_TYPE)
  // ══════════════════════════════════════════════════════════════════════════

  private parseTypeBlock(): TypeDeclarationNode[] {
    const declarations: TypeDeclarationNode[] = [];
    this.expect(TokenType.TYPE);

    while (!this.isAtEnd() && !this.halted && !this.check(TokenType.END_TYPE)) {
      const start = this.peek();
      const typeName = this.expect(TokenType.IDENTIFIER, ParserErrorCode.EXPECTED_IDENTIFIER, 'Expected type name').value;
      this.expect(TokenType.COLON, ParserErrorCode.EXPECTED_COLON, 'Expected : after type name');

      let typeNode: TypeNode;
      if (this.check(TokenType.STRUCT)) {
        typeNode = this.parseStructType();
      } else if (this.check(TokenType.LPAREN) || this.checkEnumStart()) {
        typeNode = this.parseEnumType();
      } else {
        typeNode = this.parseType();
      }

      this.match(TokenType.SEMICOLON);

      declarations.push({
        kind: 'typeDeclaration',
        name: typeName,
        type: typeNode,
        location: this.loc(start),
      });
    }

    this.expect(TokenType.END_TYPE, ParserErrorCode.MISSING_END_TYPE, 'Expected END_TYPE');
    return declarations;
  }

  /** Check if current token starts an enum: ( identifier , ... ) */
  private checkEnumStart(): boolean {
    // ENUM keyword or parenthesized list
    return this.check(TokenType.ENUM);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Variable Blocks
  // ══════════════════════════════════════════════════════════════════════════

  private parseVarBlocks(): VarBlockNode[] {
    const blocks: VarBlockNode[] = [];
    while (!this.isAtEnd() && !this.halted && VAR_BLOCK_TOKENS.has(this.peek().type)) {
      blocks.push(this.parseVarBlock());
    }
    return blocks;
  }

  private parseVarBlock(): VarBlockNode {
    const start = this.peek();
    const blockType = this.tokenToVarBlockKind(start.type);
    this.advance(); // consume VAR / VAR_INPUT / etc.

    let constant = false;
    let retain = false;
    let persistent = false;

    // Parse qualifiers: CONSTANT, RETAIN, PERSISTENT (in any order)
    while (
      this.check(TokenType.CONSTANT) ||
      this.check(TokenType.RETAIN) ||
      this.check(TokenType.PERSISTENT)
    ) {
      if (this.match(TokenType.CONSTANT)) constant = true;
      if (this.match(TokenType.RETAIN)) retain = true;
      if (this.match(TokenType.PERSISTENT)) persistent = true;
    }

    const declarations: VarDeclarationNode[] = [];

    while (!this.isAtEnd() && !this.halted && !this.check(TokenType.END_VAR)) {
      try {
        const decl = this.parseVarDeclaration();
        if (decl) declarations.push(decl);
      } catch {
        this.synchronize(RecoveryStrategy.SYNC_SEMICOLON);
      }
    }

    this.expect(TokenType.END_VAR, ParserErrorCode.MISSING_END_VAR, 'Expected END_VAR');

    return {
      kind: 'varBlock',
      blockType,
      constant,
      retain,
      persistent,
      declarations,
      location: this.loc(start),
    };
  }

  private tokenToVarBlockKind(type: TokenType): VarBlockKind {
    switch (type) {
      case TokenType.VAR:          return 'VAR';
      case TokenType.VAR_INPUT:    return 'VAR_INPUT';
      case TokenType.VAR_OUTPUT:   return 'VAR_OUTPUT';
      case TokenType.VAR_IN_OUT:   return 'VAR_IN_OUT';
      case TokenType.VAR_GLOBAL:   return 'VAR_GLOBAL';
      case TokenType.VAR_TEMP:     return 'VAR_TEMP';
      case TokenType.VAR_EXTERNAL: return 'VAR_EXTERNAL';
      default:                     return 'VAR';
    }
  }

  private parseVarDeclaration(): VarDeclarationNode | null {
    // Skip stray semicolons
    if (this.check(TokenType.SEMICOLON)) {
      this.advance();
      return null;
    }

    const start = this.peek();

    // Parse name list: name1, name2, name3
    const names: string[] = [];
    names.push(this.expect(TokenType.IDENTIFIER, ParserErrorCode.EXPECTED_IDENTIFIER, 'Expected variable name').value);

    while (this.match(TokenType.COMMA)) {
      names.push(this.expect(TokenType.IDENTIFIER, ParserErrorCode.EXPECTED_IDENTIFIER, 'Expected variable name').value);
    }

    // Optional: AT %IX0.0
    let atAddress: string | undefined;
    if (this.match(TokenType.AT)) {
      // The address is typically an identifier like %IX0.0 or a string
      const addrToken = this.advance();
      atAddress = addrToken.value;
      // Consume dotted parts
      while (this.match(TokenType.DOT)) {
        atAddress += '.' + this.advance().value;
      }
    }

    this.expect(TokenType.COLON, ParserErrorCode.EXPECTED_COLON, 'Expected : after variable name(s)');

    const type = this.parseType();

    // Optional initial value: := expression
    let initialValue: Expression | undefined;
    if (this.match(TokenType.ASSIGN)) {
      initialValue = this.parseExpression();
    }

    this.expect(TokenType.SEMICOLON, ParserErrorCode.EXPECTED_SEMICOLON, 'Expected ; after variable declaration');

    return {
      kind: 'varDeclaration',
      names,
      type,
      initialValue,
      atAddress,
      location: this.loc(start),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Type Parsing
  // ══════════════════════════════════════════════════════════════════════════

  private parseType(): TypeNode {
    const tok = this.peek();

    // ARRAY[...] OF <type>
    if (tok.type === TokenType.ARRAY) {
      return this.parseArrayType();
    }

    // STRUCT ... END_STRUCT
    if (tok.type === TokenType.STRUCT) {
      return this.parseStructType();
    }

    // STRING[length] / WSTRING[length]
    if (tok.type === TokenType.STRING || tok.type === TokenType.WSTRING) {
      return this.parseStringType();
    }

    // Elementary data type keywords
    if (DATA_TYPE_TOKENS.has(tok.type)) {
      const t = this.advance();
      return {
        kind: 'elementaryType',
        name: t.value.toUpperCase(),
        location: this.loc(t),
      };
    }

    // ENUM keyword
    if (tok.type === TokenType.ENUM) {
      return this.parseEnumType();
    }

    // Named type (user-defined or identifier)
    if (tok.type === TokenType.IDENTIFIER) {
      const t = this.advance();
      return {
        kind: 'namedType',
        name: t.value,
        location: this.loc(t),
      };
    }

    // Parenthesized enum literal: (val1, val2, ...)
    if (tok.type === TokenType.LPAREN) {
      return this.parseEnumType();
    }

    this.addError(ParserErrorCode.EXPECTED_TYPE, `Expected type, got ${tok.type} ('${tok.value}')`, tok);
    return {
      kind: 'elementaryType',
      name: 'UNKNOWN',
      location: this.loc(tok),
    };
  }

  private parseArrayType(): ArrayTypeNode {
    const start = this.expect(TokenType.ARRAY);
    this.expect(TokenType.LBRACKET, ParserErrorCode.EXPECTED_RBRACKET, 'Expected [ after ARRAY');

    const dimensions: ArrayDimension[] = [];
    dimensions.push(this.parseArrayDimension());
    while (this.match(TokenType.COMMA)) {
      dimensions.push(this.parseArrayDimension());
    }

    this.expect(TokenType.RBRACKET, ParserErrorCode.EXPECTED_RBRACKET, 'Expected ] after array dimensions');
    this.expect(TokenType.OF, ParserErrorCode.MISSING_OF, 'Expected OF after array dimensions');

    const elementType = this.parseType();

    return {
      kind: 'arrayType',
      dimensions,
      elementType,
      location: this.loc(start),
    };
  }

  private parseArrayDimension(): ArrayDimension {
    const lower = this.parseExpression();
    this.expect(TokenType.DOTDOT, ParserErrorCode.INVALID_ARRAY_DIMENSION, 'Expected .. in array dimension');
    const upper = this.parseExpression();
    return { lower, upper };
  }

  private parseStringType(): TypeNode {
    const tok = this.advance(); // STRING or WSTRING
    const baseType = tok.value.toUpperCase() as 'STRING' | 'WSTRING';

    if (this.match(TokenType.LBRACKET)) {
      const maxLength = this.parseExpression();
      this.expect(TokenType.RBRACKET, ParserErrorCode.EXPECTED_RBRACKET, 'Expected ] after string length');
      return {
        kind: 'stringType',
        baseType,
        maxLength,
        location: this.loc(tok),
      };
    }

    return {
      kind: 'stringType',
      baseType,
      location: this.loc(tok),
    };
  }

  private parseStructType(): StructTypeNode {
    const start = this.expect(TokenType.STRUCT);
    const members: StructMemberNode[] = [];

    while (!this.isAtEnd() && !this.halted && !this.check(TokenType.END_STRUCT)) {
      const mStart = this.peek();
      const mName = this.expect(TokenType.IDENTIFIER, ParserErrorCode.EXPECTED_IDENTIFIER, 'Expected struct member name').value;
      this.expect(TokenType.COLON, ParserErrorCode.EXPECTED_COLON, 'Expected : after struct member name');
      const mType = this.parseType();
      let mInit: Expression | undefined;
      if (this.match(TokenType.ASSIGN)) {
        mInit = this.parseExpression();
      }
      this.expect(TokenType.SEMICOLON, ParserErrorCode.EXPECTED_SEMICOLON, 'Expected ; after struct member');
      members.push({
        kind: 'structMember',
        name: mName,
        type: mType,
        initialValue: mInit,
        location: this.loc(mStart),
      });
    }

    this.expect(TokenType.END_STRUCT, ParserErrorCode.MISSING_END_STRUCT, 'Expected END_STRUCT');

    return {
      kind: 'structType',
      members,
      location: this.loc(start),
    };
  }

  private parseEnumType(): EnumTypeNode {
    const start = this.peek();
    let baseType: TypeNode | undefined;

    // Optional ENUM keyword or just parenthesized list
    if (this.match(TokenType.ENUM)) {
      // optional base type: ENUM (val := 0, ...) INT
      // Not standard but common in Codesys
    }

    this.expect(TokenType.LPAREN, ParserErrorCode.UNEXPECTED_TOKEN, 'Expected ( for enum values');

    const members: EnumMemberNode[] = [];
    if (!this.check(TokenType.RPAREN)) {
      do {
        const eStart = this.peek();
        const eName = this.expect(TokenType.IDENTIFIER).value;
        let eValue: Expression | undefined;
        if (this.match(TokenType.ASSIGN)) {
          eValue = this.parseExpression();
        }
        members.push({
          kind: 'enumMember',
          name: eName,
          value: eValue,
          location: this.loc(eStart),
        });
      } while (this.match(TokenType.COMMA));
    }

    this.expect(TokenType.RPAREN, ParserErrorCode.EXPECTED_RPAREN, 'Expected ) after enum values');

    // Optional base type after closing paren
    if (DATA_TYPE_TOKENS.has(this.peek().type)) {
      baseType = this.parseType();
    }

    return {
      kind: 'enumType',
      baseType,
      members,
      location: this.loc(start),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Statement Parsing
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Parse statements until hitting one of the stop tokens.
   * Additional identifier values can be used as stop (e.g. 'END_GET', 'END_SET').
   */
  private parseStatementList(...stopTokens: TokenType[]): Statement[] {
    const statements: Statement[] = [];
    const stopSet = new Set(stopTokens);

    while (!this.isAtEnd() && !this.halted) {
      const t = this.peek();

      // Check stop conditions
      if (stopSet.has(t.type)) break;

      // Special: stop on identifier that looks like END_GET / END_SET
      if (t.type === TokenType.IDENTIFIER) {
        const upper = t.value.toUpperCase();
        if (upper === 'END_GET' || upper === 'END_SET') break;
      }

      // Also break if we hit a POU end token or var block we don't expect
      if (POU_END_TOKENS.has(t.type)) break;

      try {
        const stmt = this.parseStatement();
        if (stmt) statements.push(stmt);
      } catch {
        this.synchronize(RecoveryStrategy.SYNC_SEMICOLON);
      }
    }

    return statements;
  }

  private parseStatement(): Statement | null {
    if (this.halted) return null;
    this.checkTimeout();

    const tok = this.peek();

    switch (tok.type) {
      case TokenType.SEMICOLON: {
        const s = this.advance();
        return { kind: 'emptyStatement', location: this.loc(s) };
      }

      case TokenType.IF:
        return this.parseIfStatement();

      case TokenType.CASE:
        return this.parseCaseStatement();

      case TokenType.FOR:
        return this.parseForStatement();

      case TokenType.WHILE:
        return this.parseWhileStatement();

      case TokenType.REPEAT:
        return this.parseRepeatStatement();

      case TokenType.RETURN: {
        const s = this.advance();
        this.expect(TokenType.SEMICOLON, ParserErrorCode.EXPECTED_SEMICOLON, 'Expected ; after RETURN');
        return { kind: 'returnStatement', location: this.loc(s) };
      }

      case TokenType.EXIT: {
        const s = this.advance();
        this.expect(TokenType.SEMICOLON, ParserErrorCode.EXPECTED_SEMICOLON, 'Expected ; after EXIT');
        return { kind: 'exitStatement', location: this.loc(s) };
      }

      case TokenType.IDENTIFIER:
        return this.parseAssignmentOrCallStatement();

      default:
        // Try to parse as expression statement
        if (this.isExpressionStart(tok.type)) {
          return this.parseExpressionStatement();
        }
        this.addError(
          ParserErrorCode.UNEXPECTED_TOKEN,
          `Unexpected token '${tok.value}' at start of statement`,
          tok,
        );
        this.advance();
        return null;
    }
  }

  private isExpressionStart(type: TokenType): boolean {
    return (
      type === TokenType.IDENTIFIER ||
      type === TokenType.INTEGER_LITERAL ||
      type === TokenType.REAL_LITERAL ||
      type === TokenType.STRING_LITERAL ||
      type === TokenType.BOOLEAN_LITERAL ||
      type === TokenType.TIME_LITERAL ||
      type === TokenType.DATE_LITERAL ||
      type === TokenType.HEX_LITERAL ||
      type === TokenType.OCTAL_LITERAL ||
      type === TokenType.BINARY_LITERAL ||
      type === TokenType.NOT ||
      type === TokenType.MINUS ||
      type === TokenType.PLUS ||
      type === TokenType.LPAREN ||
      type === TokenType.TRUE ||
      type === TokenType.FALSE
    );
  }

  /** Parse identifier-started statement: could be assignment, FB call, or function call */
  private parseAssignmentOrCallStatement(): Statement {
    const start = this.peek();

    // Parse the left-hand side as an expression (handles member access, array access, etc.)
    const lhs = this.parseExpression();

    // Assignment: expr := expr ;
    if (this.match(TokenType.ASSIGN)) {
      const value = this.parseExpression();
      this.expect(TokenType.SEMICOLON, ParserErrorCode.EXPECTED_SEMICOLON, 'Expected ; after assignment');
      return {
        kind: 'assignment',
        target: lhs,
        value,
        location: this.loc(start),
      } as AssignmentStatement;
    }

    // FB call with params: fbName(IN := val, ...);
    // This is already handled as a function call expression in parseExpression
    // Just consume the semicolon
    this.expect(TokenType.SEMICOLON, ParserErrorCode.EXPECTED_SEMICOLON, 'Expected ; after statement');

    return {
      kind: 'expressionStatement',
      expression: lhs,
      location: this.loc(start),
    };
  }

  private parseExpressionStatement(): Statement {
    const start = this.peek();
    const expr = this.parseExpression();
    this.expect(TokenType.SEMICOLON, ParserErrorCode.EXPECTED_SEMICOLON, 'Expected ; after expression');
    return {
      kind: 'expressionStatement',
      expression: expr,
      location: this.loc(start),
    };
  }

  // ── Control Flow Statements ─────────────────────────────────────────────

  private parseIfStatement(): IfStatement {
    this.depth++;
    this.checkDepth();
    const start = this.expect(TokenType.IF);
    const condition = this.parseExpression();
    this.expect(TokenType.THEN, ParserErrorCode.MISSING_THEN, 'Expected THEN after IF condition');

    const thenBody = this.parseStatementList(TokenType.ELSIF, TokenType.ELSE, TokenType.END_IF);

    const elsifBranches: ElsifBranch[] = [];
    while (this.check(TokenType.ELSIF) && !this.halted) {
      const elsifStart = this.advance();
      const elsifCondition = this.parseExpression();
      this.expect(TokenType.THEN, ParserErrorCode.MISSING_THEN, 'Expected THEN after ELSIF condition');
      const elsifBody = this.parseStatementList(TokenType.ELSIF, TokenType.ELSE, TokenType.END_IF);
      elsifBranches.push({
        condition: elsifCondition,
        body: elsifBody,
        location: this.loc(elsifStart),
      });
    }

    let elseBody: Statement[] | undefined;
    if (this.match(TokenType.ELSE)) {
      elseBody = this.parseStatementList(TokenType.END_IF);
    }

    this.expect(TokenType.END_IF, ParserErrorCode.MISSING_END_IF, 'Expected END_IF');

    this.depth--;
    return {
      kind: 'ifStatement',
      condition,
      thenBody,
      elsifBranches,
      elseBody,
      location: this.loc(start),
    };
  }

  private parseCaseStatement(): CaseStatement {
    this.depth++;
    this.checkDepth();
    const start = this.expect(TokenType.CASE);
    const expression = this.parseExpression();
    this.expect(TokenType.OF, ParserErrorCode.MISSING_OF, 'Expected OF after CASE expression');

    const cases: CaseBranch[] = [];
    while (
      !this.isAtEnd() &&
      !this.halted &&
      !this.check(TokenType.END_CASE) &&
      !this.check(TokenType.ELSE)
    ) {
      const caseStart = this.peek();
      const labels = this.parseCaseLabels();
      this.expect(TokenType.COLON, ParserErrorCode.EXPECTED_COLON, 'Expected : after case label(s)');
      const body = this.parseCaseBody();
      cases.push({ labels, body, location: this.loc(caseStart) });
    }

    let elseBody: Statement[] | undefined;
    if (this.match(TokenType.ELSE)) {
      elseBody = this.parseCaseBody();
    }

    this.expect(TokenType.END_CASE, ParserErrorCode.MISSING_END_CASE, 'Expected END_CASE');

    this.depth--;
    return {
      kind: 'caseStatement',
      expression,
      cases,
      elseBody,
      location: this.loc(start),
    };
  }

  private parseCaseLabels(): CaseLabel[] {
    const labels: CaseLabel[] = [];
    do {
      const value = this.parseExpression();
      if (this.match(TokenType.DOTDOT)) {
        const upper = this.parseExpression();
        labels.push({ kind: 'range', lower: value, upper });
      } else {
        labels.push({ kind: 'single', value });
      }
    } while (this.match(TokenType.COMMA));
    return labels;
  }

  /** Parse case body: statements until next label, ELSE, or END_CASE */
  private parseCaseBody(): Statement[] {
    const statements: Statement[] = [];
    while (!this.isAtEnd() && !this.halted) {
      const t = this.peek();
      // Stop at END_CASE, ELSE
      if (t.type === TokenType.END_CASE || t.type === TokenType.ELSE) break;
      // Stop at start of a new case label (integer, identifier not followed by :=)
      if (this.isCaseLabelStart()) break;
      try {
        const stmt = this.parseStatement();
        if (stmt) statements.push(stmt);
      } catch {
        this.synchronize(RecoveryStrategy.SYNC_SEMICOLON);
      }
    }
    return statements;
  }

  /** Heuristic: are we at the start of a new case label? */
  private isCaseLabelStart(): boolean {
    const t = this.peek();
    // Literal followed by : or ..
    if (
      t.type === TokenType.INTEGER_LITERAL ||
      t.type === TokenType.HEX_LITERAL
    ) {
      const next = this.peekAt(1);
      if (next.type === TokenType.COLON || next.type === TokenType.DOTDOT || next.type === TokenType.COMMA) {
        return true;
      }
    }
    // Identifier (enum value) followed by : or ..
    if (t.type === TokenType.IDENTIFIER) {
      const next = this.peekAt(1);
      if (next.type === TokenType.COLON && this.peekAt(2).type !== TokenType.EQ) {
        // identifier : (not :=) → could be a case label
        return true;
      }
      if (next.type === TokenType.DOTDOT || next.type === TokenType.COMMA) {
        return true;
      }
    }
    return false;
  }

  private parseForStatement(): ForStatement {
    this.depth++;
    this.checkDepth();
    const start = this.expect(TokenType.FOR);
    const variable = this.expect(TokenType.IDENTIFIER, ParserErrorCode.EXPECTED_IDENTIFIER, 'Expected loop variable').value;
    this.expect(TokenType.ASSIGN, ParserErrorCode.EXPECTED_ASSIGN, 'Expected := after FOR variable');
    const from = this.parseExpression();
    this.expect(TokenType.TO, ParserErrorCode.MISSING_TO, 'Expected TO in FOR statement');
    const to = this.parseExpression();

    let by: Expression | undefined;
    if (this.match(TokenType.BY)) {
      by = this.parseExpression();
    }

    this.expect(TokenType.DO, ParserErrorCode.MISSING_DO, 'Expected DO in FOR statement');
    const body = this.parseStatementList(TokenType.END_FOR);
    this.expect(TokenType.END_FOR, ParserErrorCode.MISSING_END_FOR, 'Expected END_FOR');

    this.depth--;
    return {
      kind: 'forStatement',
      variable,
      from,
      to,
      by,
      body,
      location: this.loc(start),
    };
  }

  private parseWhileStatement(): WhileStatement {
    this.depth++;
    this.checkDepth();
    const start = this.expect(TokenType.WHILE);
    const condition = this.parseExpression();
    this.expect(TokenType.DO, ParserErrorCode.MISSING_DO, 'Expected DO after WHILE condition');
    const body = this.parseStatementList(TokenType.END_WHILE);
    this.expect(TokenType.END_WHILE, ParserErrorCode.MISSING_END_WHILE, 'Expected END_WHILE');

    this.depth--;
    return {
      kind: 'whileStatement',
      condition,
      body,
      location: this.loc(start),
    };
  }

  private parseRepeatStatement(): RepeatStatement {
    this.depth++;
    this.checkDepth();
    const start = this.expect(TokenType.REPEAT);
    const body = this.parseStatementList(TokenType.UNTIL);
    this.expect(TokenType.UNTIL, ParserErrorCode.MISSING_UNTIL, 'Expected UNTIL after REPEAT body');
    const condition = this.parseExpression();
    this.expect(TokenType.END_REPEAT, ParserErrorCode.MISSING_END_REPEAT, 'Expected END_REPEAT');

    this.depth--;
    return {
      kind: 'repeatStatement',
      body,
      condition,
      location: this.loc(start),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Expression Parsing (Pratt / Precedence Climbing)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Parse expression with minimum precedence.
   * Uses precedence climbing (Pratt-style).
   */
  private parseExpression(minPrec: number = 0): Expression {
    this.depth++;
    this.checkDepth();
    if (this.halted) {
      this.depth--;
      return this.errorExpression();
    }

    let left = this.parseUnaryExpression();

    while (!this.isAtEnd() && !this.halted) {
      const opToken = this.peek();
      const prec = getPrecedence(opToken.type);
      if (prec <= minPrec) break;

      const op = tokenToBinaryOp(opToken.type);
      if (!op) break;

      this.advance(); // consume operator
      // Right-associative for **: use prec-1 so same-precedence ** is consumed
      const nextMinPrec = opToken.type === TokenType.POWER ? prec - 1 : prec;
      const right = this.parseExpression(nextMinPrec);

      const prevTok = this.previous();
      left = {
        kind: 'binaryExpression',
        operator: op,
        left,
        right,
        location: {
          startLine: left.location.startLine,
          startCol: left.location.startCol,
          endLine: prevTok.line,
          endCol: prevTok.col + Math.max(prevTok.length, 1),
        },
      };
    }

    this.depth--;
    return left;
  }

  private parseUnaryExpression(): Expression {
    const tok = this.peek();

    // NOT expr
    if (tok.type === TokenType.NOT) {
      const opTok = this.advance();
      const operand = this.parseUnaryExpression();
      return {
        kind: 'unaryExpression',
        operator: 'NOT' as UnaryOperator,
        operand,
        location: {
          startLine: opTok.line,
          startCol: opTok.col,
          endLine: this.previous().line,
          endCol: this.previous().col + Math.max(this.previous().length, 1),
        },
      };
    }

    // Unary - or +
    if (tok.type === TokenType.MINUS || tok.type === TokenType.PLUS) {
      const opTok = this.advance();
      const operand = this.parseUnaryExpression();
      return {
        kind: 'unaryExpression',
        operator: (opTok.type === TokenType.MINUS ? '-' : '+') as UnaryOperator,
        operand,
        location: {
          startLine: opTok.line,
          startCol: opTok.col,
          endLine: this.previous().line,
          endCol: this.previous().col + Math.max(this.previous().length, 1),
        },
      };
    }

    return this.parsePostfixExpression();
  }

  /** Parse postfix operations: member access (.), array access ([]), dereference (^), function call (()) */
  private parsePostfixExpression(): Expression {
    let expr = this.parsePrimaryExpression();

    while (!this.isAtEnd() && !this.halted) {
      if (this.check(TokenType.DOT)) {
        this.advance();
        const memberToken = this.expect(TokenType.IDENTIFIER, ParserErrorCode.INVALID_MEMBER_ACCESS, 'Expected member name after .');
        expr = {
          kind: 'memberAccess',
          object: expr,
          member: memberToken.value,
          location: {
            startLine: expr.location.startLine,
            startCol: expr.location.startCol,
            endLine: memberToken.line,
            endCol: memberToken.col + memberToken.length,
          },
        };
      } else if (this.check(TokenType.LBRACKET)) {
        this.advance();
        const indices: Expression[] = [this.parseExpression()];
        while (this.match(TokenType.COMMA)) {
          indices.push(this.parseExpression());
        }
        const closeBracket = this.expect(TokenType.RBRACKET, ParserErrorCode.EXPECTED_RBRACKET, 'Expected ] after array index');
        expr = {
          kind: 'arrayAccess',
          array: expr,
          indices,
          location: {
            startLine: expr.location.startLine,
            startCol: expr.location.startCol,
            endLine: closeBracket.line,
            endCol: closeBracket.col + Math.max(closeBracket.length, 1),
          },
        };
      } else if (this.check(TokenType.ARROW)) {
        this.advance();
        expr = {
          kind: 'deref',
          operand: expr,
          location: {
            startLine: expr.location.startLine,
            startCol: expr.location.startCol,
            endLine: this.previous().line,
            endCol: this.previous().col + 1,
          },
        };
      } else {
        break;
      }
    }

    return expr;
  }

  private parsePrimaryExpression(): Expression {
    const tok = this.peek();

    switch (tok.type) {
      // Parenthesized expression
      case TokenType.LPAREN: {
        const open = this.advance();
        const inner = this.parseExpression();
        const close = this.expect(TokenType.RPAREN, ParserErrorCode.EXPECTED_RPAREN, 'Expected )');
        return {
          kind: 'parenthesized',
          expression: inner,
          location: {
            startLine: open.line,
            startCol: open.col,
            endLine: close.line,
            endCol: close.col + Math.max(close.length, 1),
          },
        };
      }

      // Identifier or function call
      case TokenType.IDENTIFIER: {
        const idTok = this.advance();

        // Function call: name(args)
        if (this.check(TokenType.LPAREN)) {
          return this.parseFunctionCallArgs(idTok);
        }

        return {
          kind: 'identifier',
          name: idTok.value,
          location: this.loc(idTok),
        };
      }

      // Integer literal
      case TokenType.INTEGER_LITERAL: {
        const t = this.advance();
        return {
          kind: 'integerLiteral',
          value: this.parseIntValue(t.value),
          raw: t.value,
          location: this.loc(t),
        };
      }

      // Real literal
      case TokenType.REAL_LITERAL: {
        const t = this.advance();
        return {
          kind: 'realLiteral',
          value: parseFloat(t.value.replace(/_/g, '')),
          raw: t.value,
          location: this.loc(t),
        };
      }

      // String literal
      case TokenType.STRING_LITERAL: {
        const t = this.advance();
        return {
          kind: 'stringLiteral',
          value: t.value.slice(1, -1), // remove quotes
          raw: t.value,
          location: this.loc(t),
        };
      }

      // Boolean literal
      case TokenType.BOOLEAN_LITERAL:
      case TokenType.TRUE:
      case TokenType.FALSE: {
        const t = this.advance();
        return {
          kind: 'booleanLiteral',
          value: t.value.toUpperCase().includes('TRUE'),
          raw: t.value,
          location: this.loc(t),
        };
      }

      // Time literal
      case TokenType.TIME_LITERAL: {
        const t = this.advance();
        return {
          kind: 'timeLiteral',
          raw: t.value,
          location: this.loc(t),
        };
      }

      // Date literal
      case TokenType.DATE_LITERAL: {
        const t = this.advance();
        return {
          kind: 'dateLiteral',
          raw: t.value,
          location: this.loc(t),
        };
      }

      // Hex literal
      case TokenType.HEX_LITERAL: {
        const t = this.advance();
        return {
          kind: 'hexLiteral',
          raw: t.value,
          value: parseInt(t.value.replace(/^16#/, '').replace(/_/g, ''), 16),
          location: this.loc(t),
        };
      }

      // Octal literal
      case TokenType.OCTAL_LITERAL: {
        const t = this.advance();
        return {
          kind: 'octalLiteral',
          raw: t.value,
          value: parseInt(t.value.replace(/^8#/, '').replace(/_/g, ''), 8),
          location: this.loc(t),
        };
      }

      // Binary literal
      case TokenType.BINARY_LITERAL: {
        const t = this.advance();
        return {
          kind: 'binaryLiteral',
          raw: t.value,
          value: parseInt(t.value.replace(/^2#/, '').replace(/_/g, ''), 2),
          location: this.loc(t),
        };
      }

      default:
        this.addError(
          ParserErrorCode.EXPECTED_EXPRESSION,
          `Expected expression, got ${tok.type} ('${tok.value}')`,
          tok,
        );
        this.advance();
        return this.errorExpression();
    }
  }

  /** Parse function/FB call arguments after the opening '(' */
  private parseFunctionCallArgs(nameToken: Token): FunctionCallExpression {
    this.advance(); // consume (

    const args: Expression[] = [];
    const namedArgs: NamedArgument[] = [];

    if (!this.check(TokenType.RPAREN)) {
      do {
        const argStart = this.peek();

        // Check for named argument: name := value or name => value
        if (
          argStart.type === TokenType.IDENTIFIER &&
          (this.peekAt(1).type === TokenType.ASSIGN || this.peekAt(1).type === TokenType.OUTPUT_ASSIGN)
        ) {
          const argName = this.advance().value;
          const assignType = this.peek().type === TokenType.OUTPUT_ASSIGN ? 'output' : 'input';
          this.advance(); // consume := or =>
          const argValue = this.parseExpression();
          namedArgs.push({
            name: argName,
            value: argValue,
            assignType: assignType as 'input' | 'output',
            location: this.loc(argStart),
          });
        } else {
          // Positional argument
          args.push(this.parseExpression());
        }
      } while (this.match(TokenType.COMMA));
    }

    const closeParen = this.expect(TokenType.RPAREN, ParserErrorCode.EXPECTED_RPAREN, 'Expected ) after function arguments');

    return {
      kind: 'functionCall',
      name: nameToken.value,
      args,
      namedArgs,
      location: {
        startLine: nameToken.line,
        startCol: nameToken.col,
        endLine: closeParen.line,
        endCol: closeParen.col + Math.max(closeParen.length, 1),
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Helpers
  // ══════════════════════════════════════════════════════════════════════════

  /** Parse integer value from token value string (handles typed prefixes and underscores) */
  private parseIntValue(raw: string): number {
    // Remove typed prefix (e.g. DINT#123 → 123)
    const hashIdx = raw.indexOf('#');
    let numStr = hashIdx >= 0 ? raw.substring(hashIdx + 1) : raw;
    numStr = numStr.replace(/_/g, '');
    const val = parseInt(numStr, 10);
    return isNaN(val) ? 0 : val;
  }

  /** Create an error placeholder expression */
  private errorExpression(): Expression {
    const tok = this.peek();
    return {
      kind: 'identifier',
      name: '<error>',
      location: {
        startLine: tok.line,
        startCol: tok.col,
        endLine: tok.line,
        endCol: tok.col + 1,
      },
    };
  }
}
