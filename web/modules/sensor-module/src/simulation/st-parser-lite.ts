/**
 * IEC 61131-3 Structured Text Lightweight Parser (Browser-Side)
 *
 * Self-contained tokenizer + recursive descent parser with Pratt
 * precedence climbing for expressions. Zero external dependencies.
 *
 * Produces AST nodes compatible with the st-ast-types.ts interfaces.
 *
 * Supported constructs:
 *   POU:        PROGRAM, FUNCTION_BLOCK, FUNCTION
 *   VarBlocks:  VAR, VAR_INPUT, VAR_OUTPUT, VAR_IN_OUT, VAR_GLOBAL (CONSTANT, RETAIN)
 *   Types:      BOOL, BYTE, WORD, DWORD, SINT, INT, DINT, LINT, USINT, UINT, UDINT,
 *               ULINT, REAL, LREAL, STRING, WSTRING, TIME, DATE, ARRAY[n..m] OF type
 *   Statements: IF/ELSIF/ELSE, CASE, FOR, WHILE, REPEAT, assignment, RETURN, EXIT
 *   Expressions: arithmetic (+,-,*,/,MOD,**), comparison (=,<>,<,>,<=,>=),
 *                boolean (AND, OR, XOR, NOT), bitwise (SHL, SHR, ROL, ROR),
 *                function calls (positional & named args), member access, array access,
 *                literals (integer, hex, real, string, boolean, time)
 *   Comments:   // line, (* block *)
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
  IfStatement,
  ElsifBranch,
  CaseStatement,
  CaseBranch,
  CaseLabel,
  ForStatement,
  WhileStatement,
  RepeatStatement,
  Expression,
  BinaryOperator,
  UnaryOperator,
  SourceLocation,
  NamedArgument,
} from './st-ast-types';

// ════════════════════════════════════════════════════════════════════════════
// Public API
// ════════════════════════════════════════════════════════════════════════════

export interface ParseError {
  message: string;
  line: number;
  col: number;
}

export interface ParseResult {
  ast: ASTNode[];
  errors: ParseError[];
}

export function parseST(source: string): ParseResult {
  const lexer = new Tokenizer(source);
  const tokens = lexer.tokenize();
  const parser = new Parser(tokens);
  return parser.parse();
}

// ════════════════════════════════════════════════════════════════════════════
// Token Types
// ════════════════════════════════════════════════════════════════════════════

const enum TT {
  // Literals
  INTEGER, REAL, STRING_LIT, BOOL_TRUE, BOOL_FALSE, TIME_LIT, HEX_LIT,
  // Identifier
  IDENT,
  // Keywords - POU
  PROGRAM, END_PROGRAM, FUNCTION_BLOCK, END_FUNCTION_BLOCK, FUNCTION, END_FUNCTION,
  // Keywords - Var
  VAR, VAR_INPUT, VAR_OUTPUT, VAR_IN_OUT, VAR_GLOBAL, END_VAR,
  CONSTANT, RETAIN,
  // Keywords - Types
  BOOL, BYTE, WORD, DWORD,
  SINT, INT, DINT, LINT,
  USINT, UINT, UDINT, ULINT,
  REAL_KW, LREAL, STRING_KW, WSTRING, TIME_KW, DATE_KW,
  ARRAY, OF,
  // Keywords - Control flow
  IF, THEN, ELSIF, ELSE, END_IF,
  CASE, END_CASE,
  FOR, TO, BY, DO, END_FOR,
  WHILE, END_WHILE,
  REPEAT, UNTIL, END_REPEAT,
  RETURN, EXIT,
  // Keywords - Operators
  AND, OR, XOR, NOT, MOD,
  SHL, SHR, ROL, ROR,
  // Symbols
  ASSIGN,     // :=
  ARROW,      // =>
  COLON,      // :
  SEMICOLON,  // ;
  COMMA,      // ,
  DOT,        // .
  DOTDOT,     // ..
  LPAREN,     // (
  RPAREN,     // )
  LBRACKET,   // [
  RBRACKET,   // ]
  PLUS, MINUS, STAR, SLASH, POWER,  // + - * / **
  EQ, NEQ, LT, GT, LE, GE,         // = <> < > <= >=
  HASH,       // #
  // Special
  EOF,
}

interface Token {
  type: TT;
  value: string;
  line: number;
  col: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Keyword Map
// ════════════════════════════════════════════════════════════════════════════

const KEYWORDS = new Map<string, TT>([
  ['PROGRAM', TT.PROGRAM], ['END_PROGRAM', TT.END_PROGRAM],
  ['FUNCTION_BLOCK', TT.FUNCTION_BLOCK], ['END_FUNCTION_BLOCK', TT.END_FUNCTION_BLOCK],
  ['FUNCTION', TT.FUNCTION], ['END_FUNCTION', TT.END_FUNCTION],
  ['VAR', TT.VAR], ['VAR_INPUT', TT.VAR_INPUT], ['VAR_OUTPUT', TT.VAR_OUTPUT],
  ['VAR_IN_OUT', TT.VAR_IN_OUT], ['VAR_GLOBAL', TT.VAR_GLOBAL], ['END_VAR', TT.END_VAR],
  ['CONSTANT', TT.CONSTANT], ['RETAIN', TT.RETAIN],
  ['BOOL', TT.BOOL], ['BYTE', TT.BYTE], ['WORD', TT.WORD], ['DWORD', TT.DWORD],
  ['SINT', TT.SINT], ['INT', TT.INT], ['DINT', TT.DINT], ['LINT', TT.LINT],
  ['USINT', TT.USINT], ['UINT', TT.UINT], ['UDINT', TT.UDINT], ['ULINT', TT.ULINT],
  ['REAL', TT.REAL_KW], ['LREAL', TT.LREAL], ['STRING', TT.STRING_KW], ['WSTRING', TT.WSTRING],
  ['TIME', TT.TIME_KW], ['DATE', TT.DATE_KW],
  ['ARRAY', TT.ARRAY], ['OF', TT.OF],
  ['IF', TT.IF], ['THEN', TT.THEN], ['ELSIF', TT.ELSIF], ['ELSE', TT.ELSE], ['END_IF', TT.END_IF],
  ['CASE', TT.CASE], ['END_CASE', TT.END_CASE],
  ['FOR', TT.FOR], ['TO', TT.TO], ['BY', TT.BY], ['DO', TT.DO], ['END_FOR', TT.END_FOR],
  ['WHILE', TT.WHILE], ['END_WHILE', TT.END_WHILE],
  ['REPEAT', TT.REPEAT], ['UNTIL', TT.UNTIL], ['END_REPEAT', TT.END_REPEAT],
  ['RETURN', TT.RETURN], ['EXIT', TT.EXIT],
  ['AND', TT.AND], ['OR', TT.OR], ['XOR', TT.XOR], ['NOT', TT.NOT], ['MOD', TT.MOD],
  ['SHL', TT.SHL], ['SHR', TT.SHR], ['ROL', TT.ROL], ['ROR', TT.ROR],
  ['TRUE', TT.BOOL_TRUE], ['FALSE', TT.BOOL_FALSE],
]);

// ════════════════════════════════════════════════════════════════════════════
// Tokenizer
// ════════════════════════════════════════════════════════════════════════════

class Tokenizer {
  private src: string;
  private pos = 0;
  private line = 1;
  private col = 1;
  private tokens: Token[] = [];

  constructor(source: string) {
    this.src = source;
  }

  tokenize(): Token[] {
    while (this.pos < this.src.length) {
      this.skipWhitespace();
      if (this.pos >= this.src.length) break;

      const ch = this.src[this.pos]!;
      const startLine = this.line;
      const startCol = this.col;

      // Single-line comment
      if (ch === '/' && this.peek(1) === '/') {
        this.advance(); this.advance();
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.advance();
        continue;
      }

      // Block comment (* ... *)
      if (ch === '(' && this.peek(1) === '*') {
        this.advance(); this.advance();
        let depth = 1;
        while (this.pos < this.src.length && depth > 0) {
          if (this.src[this.pos] === '(' && this.peek(1) === '*') { depth++; this.advance(); this.advance(); }
          else if (this.src[this.pos] === '*' && this.peek(1) === ')') { depth--; this.advance(); this.advance(); }
          else this.advance();
        }
        continue;
      }

      // String literal (single-quoted)
      if (ch === '\'') {
        this.advance();
        let val = '';
        while (this.pos < this.src.length && this.src[this.pos] !== '\'' && this.src[this.pos] !== '\n') {
          if (this.src[this.pos] === '$' && this.pos + 1 < this.src.length) {
            this.advance(); val += this.src[this.pos]!; this.advance();
          } else {
            val += this.src[this.pos]!; this.advance();
          }
        }
        if (this.pos < this.src.length && this.src[this.pos] === '\'') this.advance();
        this.tokens.push({ type: TT.STRING_LIT, value: val, line: startLine, col: startCol });
        continue;
      }

      // String literal (double-quoted)
      if (ch === '"') {
        this.advance();
        let val = '';
        while (this.pos < this.src.length && this.src[this.pos] !== '"' && this.src[this.pos] !== '\n') {
          if (this.src[this.pos] === '$' && this.pos + 1 < this.src.length) {
            this.advance(); val += this.src[this.pos]!; this.advance();
          } else {
            val += this.src[this.pos]!; this.advance();
          }
        }
        if (this.pos < this.src.length && this.src[this.pos] === '"') this.advance();
        this.tokens.push({ type: TT.STRING_LIT, value: val, line: startLine, col: startCol });
        continue;
      }

      // Numeric literal
      if (isDigit(ch)) {
        this.scanNumber(startLine, startCol);
        continue;
      }

      // Identifier / keyword / time literal
      if (isIdentStart(ch)) {
        this.scanIdentOrKeyword(startLine, startCol);
        continue;
      }

      // Two-character operators (must check before single-char)
      if (ch === ':' && this.peek(1) === '=') { this.advance(); this.advance(); this.emit(TT.ASSIGN, ':=', startLine, startCol); continue; }
      if (ch === '=' && this.peek(1) === '>') { this.advance(); this.advance(); this.emit(TT.ARROW, '=>', startLine, startCol); continue; }
      if (ch === '<' && this.peek(1) === '>') { this.advance(); this.advance(); this.emit(TT.NEQ, '<>', startLine, startCol); continue; }
      if (ch === '<' && this.peek(1) === '=') { this.advance(); this.advance(); this.emit(TT.LE, '<=', startLine, startCol); continue; }
      if (ch === '>' && this.peek(1) === '=') { this.advance(); this.advance(); this.emit(TT.GE, '>=', startLine, startCol); continue; }
      if (ch === '*' && this.peek(1) === '*') { this.advance(); this.advance(); this.emit(TT.POWER, '**', startLine, startCol); continue; }
      if (ch === '.' && this.peek(1) === '.') { this.advance(); this.advance(); this.emit(TT.DOTDOT, '..', startLine, startCol); continue; }

      // Single-character tokens
      const singleMap: Record<string, TT> = {
        '+': TT.PLUS, '-': TT.MINUS, '*': TT.STAR, '/': TT.SLASH,
        '=': TT.EQ, '<': TT.LT, '>': TT.GT,
        '(': TT.LPAREN, ')': TT.RPAREN, '[': TT.LBRACKET, ']': TT.RBRACKET,
        ',': TT.COMMA, ';': TT.SEMICOLON, ':': TT.COLON, '.': TT.DOT, '#': TT.HASH,
      };
      const tt = singleMap[ch];
      if (tt !== undefined) {
        this.advance();
        this.emit(tt, ch, startLine, startCol);
        continue;
      }

      // Unknown character - skip
      this.advance();
    }

    this.tokens.push({ type: TT.EOF, value: '', line: this.line, col: this.col });
    return this.tokens;
  }

  private peek(offset: number): string {
    return this.pos + offset < this.src.length ? this.src[this.pos + offset]! : '\0';
  }

  private advance(): string {
    const ch = this.src[this.pos]!;
    this.pos++;
    if (ch === '\n') { this.line++; this.col = 1; } else { this.col++; }
    return ch;
  }

  private emit(type: TT, value: string, line: number, col: number): void {
    this.tokens.push({ type, value, line, col });
  }

  private skipWhitespace(): void {
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]!;
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        this.advance();
      } else {
        break;
      }
    }
  }

  private scanNumber(startLine: number, startCol: number): void {
    const startPos = this.pos;

    // Scan leading digits
    while (this.pos < this.src.length && isDigit(this.src[this.pos]!)) this.advance();

    // Check for base prefix: 16#FF, 8#77, 2#1010
    if (this.pos < this.src.length && this.src[this.pos] === '#') {
      const prefix = this.src.substring(startPos, this.pos);
      if (prefix === '16') {
        this.advance(); // consume #
        const hexStart = this.pos;
        while (this.pos < this.src.length && isHexDigit(this.src[this.pos]!)) this.advance();
        this.emit(TT.HEX_LIT, this.src.substring(startPos, this.pos), startLine, startCol);
        return;
      }
      if (prefix === '8' || prefix === '2') {
        this.advance(); // consume #
        while (this.pos < this.src.length && isDigit(this.src[this.pos]!)) this.advance();
        this.emit(TT.INTEGER, this.src.substring(startPos, this.pos), startLine, startCol);
        return;
      }
    }

    // Allow underscore separators
    while (this.pos < this.src.length && this.src[this.pos] === '_' &&
           this.pos + 1 < this.src.length && isDigit(this.src[this.pos + 1]!)) {
      this.advance();
      while (this.pos < this.src.length && isDigit(this.src[this.pos]!)) this.advance();
    }

    // Real: decimal point followed by digit
    if (this.pos < this.src.length && this.src[this.pos] === '.' &&
        this.pos + 1 < this.src.length && isDigit(this.src[this.pos + 1]!)) {
      this.advance(); // consume .
      while (this.pos < this.src.length && isDigit(this.src[this.pos]!)) this.advance();
      // Exponent
      if (this.pos < this.src.length && (this.src[this.pos] === 'e' || this.src[this.pos] === 'E')) {
        this.advance();
        if (this.pos < this.src.length && (this.src[this.pos] === '+' || this.src[this.pos] === '-')) this.advance();
        while (this.pos < this.src.length && isDigit(this.src[this.pos]!)) this.advance();
      }
      this.emit(TT.REAL, this.src.substring(startPos, this.pos), startLine, startCol);
      return;
    }

    // Exponent without decimal
    if (this.pos < this.src.length && (this.src[this.pos] === 'e' || this.src[this.pos] === 'E')) {
      this.advance();
      if (this.pos < this.src.length && (this.src[this.pos] === '+' || this.src[this.pos] === '-')) this.advance();
      while (this.pos < this.src.length && isDigit(this.src[this.pos]!)) this.advance();
      this.emit(TT.REAL, this.src.substring(startPos, this.pos), startLine, startCol);
      return;
    }

    this.emit(TT.INTEGER, this.src.substring(startPos, this.pos), startLine, startCol);
  }

  private scanIdentOrKeyword(startLine: number, startCol: number): void {
    const startPos = this.pos;
    while (this.pos < this.src.length && isIdentPart(this.src[this.pos]!)) this.advance();
    const word = this.src.substring(startPos, this.pos);
    const upper = word.toUpperCase();

    // Time literal: T#..., TIME#...
    if ((upper === 'T' || upper === 'TIME') && this.pos < this.src.length && this.src[this.pos] === '#') {
      this.advance(); // consume #
      // optional sign
      if (this.pos < this.src.length && (this.src[this.pos] === '-' || this.src[this.pos] === '+')) this.advance();
      while (this.pos < this.src.length && (isDigit(this.src[this.pos]!) || isLetter(this.src[this.pos]!) || this.src[this.pos] === '.' || this.src[this.pos] === '_')) {
        this.advance();
      }
      this.emit(TT.TIME_LIT, this.src.substring(startPos, this.pos), startLine, startCol);
      return;
    }

    // Keyword or boolean literal
    const kw = KEYWORDS.get(upper);
    if (kw !== undefined) {
      this.emit(kw, word, startLine, startCol);
      return;
    }

    // Plain identifier
    this.emit(TT.IDENT, word, startLine, startCol);
  }
}

// Character classification helpers
function isDigit(ch: string): boolean { return ch >= '0' && ch <= '9'; }
function isHexDigit(ch: string): boolean { return (ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'F') || (ch >= 'a' && ch <= 'f'); }
function isLetter(ch: string): boolean { return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z'); }
function isIdentStart(ch: string): boolean { return isLetter(ch) || ch === '_'; }
function isIdentPart(ch: string): boolean { return isLetter(ch) || isDigit(ch) || ch === '_'; }

// ════════════════════════════════════════════════════════════════════════════
// Operator Precedence (Pratt style)
// ════════════════════════════════════════════════════════════════════════════

function getPrec(t: TT): number {
  switch (t) {
    case TT.OR:                         return 1;
    case TT.XOR:                        return 2;
    case TT.AND:                        return 3;
    case TT.EQ: case TT.NEQ:
    case TT.LT: case TT.GT:
    case TT.LE: case TT.GE:            return 4;
    case TT.PLUS: case TT.MINUS:       return 5;
    case TT.STAR: case TT.SLASH:
    case TT.MOD:
    case TT.SHL: case TT.SHR:
    case TT.ROL: case TT.ROR:          return 6;
    case TT.POWER:                      return 7;
    default:                            return 0;
  }
}

function toBinOp(t: TT): BinaryOperator | null {
  switch (t) {
    case TT.OR: return 'OR'; case TT.XOR: return 'XOR'; case TT.AND: return 'AND';
    case TT.EQ: return '='; case TT.NEQ: return '<>'; case TT.LT: return '<'; case TT.GT: return '>';
    case TT.LE: return '<='; case TT.GE: return '>=';
    case TT.PLUS: return '+'; case TT.MINUS: return '-'; case TT.STAR: return '*'; case TT.SLASH: return '/';
    case TT.MOD: return 'MOD'; case TT.POWER: return '**';
    case TT.SHL: return 'SHL'; case TT.SHR: return 'SHR'; case TT.ROL: return 'ROL'; case TT.ROR: return 'ROR';
    default: return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Data type token sets
// ════════════════════════════════════════════════════════════════════════════

const DATA_TYPE_TOKENS = new Set<TT>([
  TT.BOOL, TT.BYTE, TT.WORD, TT.DWORD,
  TT.SINT, TT.INT, TT.DINT, TT.LINT,
  TT.USINT, TT.UINT, TT.UDINT, TT.ULINT,
  TT.REAL_KW, TT.LREAL, TT.STRING_KW, TT.WSTRING,
  TT.TIME_KW, TT.DATE_KW,
]);

const VAR_BLOCK_STARTS = new Set<TT>([
  TT.VAR, TT.VAR_INPUT, TT.VAR_OUTPUT, TT.VAR_IN_OUT, TT.VAR_GLOBAL,
]);

// ════════════════════════════════════════════════════════════════════════════
// Parser
// ════════════════════════════════════════════════════════════════════════════

class Parser {
  private tokens: Token[];
  private pos = 0;
  private errors: ParseError[] = [];
  private depth = 0;
  private readonly MAX_DEPTH = 50;
  private readonly MAX_ERRORS = 100;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): ParseResult {
    const ast: ASTNode[] = [];
    while (!this.isAtEnd() && this.errors.length < this.MAX_ERRORS) {
      const t = this.cur().type;
      if (t === TT.PROGRAM) ast.push(this.parseProgram());
      else if (t === TT.FUNCTION_BLOCK) ast.push(this.parseFunctionBlock());
      else if (t === TT.FUNCTION) ast.push(this.parseFunction());
      else if (t === TT.EOF) break;
      else { this.addError(`Unexpected token '${this.cur().value}'`); this.advance(); }
    }
    return { ast, errors: this.errors };
  }

  // ── Token helpers ─────────────────────────────────────────────────────

  private cur(): Token { return this.tokens[this.pos] ?? this.eof(); }
  private peekAt(off: number): Token { return this.tokens[this.pos + off] ?? this.eof(); }
  private advance(): Token { const t = this.cur(); if (t.type !== TT.EOF) this.pos++; return t; }
  private check(t: TT): boolean { return this.cur().type === t; }
  private checkAny(...ts: TT[]): boolean { return ts.includes(this.cur().type); }
  private isAtEnd(): boolean { return this.cur().type === TT.EOF; }
  private eof(): Token { return { type: TT.EOF, value: '', line: 0, col: 0 }; }

  private match(...ts: TT[]): boolean {
    if (ts.includes(this.cur().type)) { this.advance(); return true; }
    return false;
  }

  private expect(t: TT, hint?: string): Token {
    if (this.cur().type === t) return this.advance();
    this.addError(hint ?? `Expected token type ${t}, got '${this.cur().value}'`);
    return { type: t, value: '', line: this.cur().line, col: this.cur().col };
  }

  private prev(): Token { return this.tokens[this.pos - 1] ?? this.eof(); }

  private addError(msg: string): void {
    if (this.errors.length >= this.MAX_ERRORS) return;
    this.errors.push({ message: msg, line: this.cur().line, col: this.cur().col });
  }

  private loc(start: Token, end?: Token): SourceLocation {
    const e = end ?? this.prev();
    return { startLine: start.line, startCol: start.col, endLine: e.line, endCol: e.col + Math.max(e.value.length, 1) };
  }

  // ── Synchronization / error recovery ──────────────────────────────────

  private syncToSemicolon(): void {
    while (!this.isAtEnd() && !this.check(TT.SEMICOLON)) {
      if (this.checkAny(TT.END_IF, TT.END_FOR, TT.END_WHILE, TT.END_REPEAT, TT.END_CASE,
                         TT.END_PROGRAM, TT.END_FUNCTION, TT.END_FUNCTION_BLOCK)) return;
      this.advance();
    }
    if (this.check(TT.SEMICOLON)) this.advance();
  }

  // ── PROGRAM ───────────────────────────────────────────────────────────

  private parseProgram(): ProgramNode {
    const start = this.advance(); // consume PROGRAM
    const nameToken = this.expect(TT.IDENT, 'Expected program name');
    const varBlocks = this.parseVarBlocks();
    const body = this.parseStatementList(TT.END_PROGRAM);
    this.expect(TT.END_PROGRAM, "Expected 'END_PROGRAM'");
    this.match(TT.SEMICOLON);
    return { kind: 'program', name: nameToken.value, varBlocks, body, location: this.loc(start) };
  }

  // ── FUNCTION_BLOCK ────────────────────────────────────────────────────

  private parseFunctionBlock(): FunctionBlockNode {
    const start = this.advance(); // consume FUNCTION_BLOCK
    const nameToken = this.expect(TT.IDENT, 'Expected function block name');
    const varBlocks = this.parseVarBlocks();
    const body = this.parseStatementList(TT.END_FUNCTION_BLOCK);
    this.expect(TT.END_FUNCTION_BLOCK, "Expected 'END_FUNCTION_BLOCK'");
    this.match(TT.SEMICOLON);
    return { kind: 'functionBlock', name: nameToken.value, varBlocks, methods: [], properties: [], body, location: this.loc(start) };
  }

  // ── FUNCTION ──────────────────────────────────────────────────────────

  private parseFunction(): FunctionNode {
    const start = this.advance(); // consume FUNCTION
    const nameToken = this.expect(TT.IDENT, 'Expected function name');
    this.expect(TT.COLON, "Expected ':' after function name");
    const returnType = this.parseTypeNode();
    const varBlocks = this.parseVarBlocks();
    const body = this.parseStatementList(TT.END_FUNCTION);
    this.expect(TT.END_FUNCTION, "Expected 'END_FUNCTION'");
    this.match(TT.SEMICOLON);
    return { kind: 'function', name: nameToken.value, returnType, varBlocks, body, location: this.loc(start) };
  }

  // ── VAR Blocks ────────────────────────────────────────────────────────

  private parseVarBlocks(): VarBlockNode[] {
    const blocks: VarBlockNode[] = [];
    while (VAR_BLOCK_STARTS.has(this.cur().type)) {
      blocks.push(this.parseVarBlock());
    }
    return blocks;
  }

  private parseVarBlock(): VarBlockNode {
    const start = this.advance(); // consume VAR / VAR_INPUT / VAR_OUTPUT / etc.
    const blockType = this.tokenToVarBlockKind(start.type);
    let constant = false;
    let retain = false;
    if (this.match(TT.CONSTANT)) constant = true;
    if (this.match(TT.RETAIN)) retain = true;
    // Some write RETAIN CONSTANT or CONSTANT RETAIN
    if (!constant && this.match(TT.CONSTANT)) constant = true;
    if (!retain && this.match(TT.RETAIN)) retain = true;

    const declarations: VarDeclarationNode[] = [];
    while (!this.check(TT.END_VAR) && !this.isAtEnd()) {
      const decl = this.parseVarDeclaration();
      if (decl) declarations.push(decl);
    }
    this.expect(TT.END_VAR, "Expected 'END_VAR'");

    return {
      kind: 'varBlock', blockType, constant, retain, persistent: false,
      declarations, location: this.loc(start),
    };
  }

  private tokenToVarBlockKind(t: TT): VarBlockKind {
    switch (t) {
      case TT.VAR: return 'VAR';
      case TT.VAR_INPUT: return 'VAR_INPUT';
      case TT.VAR_OUTPUT: return 'VAR_OUTPUT';
      case TT.VAR_IN_OUT: return 'VAR_IN_OUT';
      case TT.VAR_GLOBAL: return 'VAR_GLOBAL';
      default: return 'VAR';
    }
  }

  private parseVarDeclaration(): VarDeclarationNode | null {
    if (!this.check(TT.IDENT)) {
      // Skip unexpected tokens inside VAR block
      if (!this.check(TT.END_VAR)) {
        this.addError(`Unexpected token '${this.cur().value}' in variable declaration`);
        this.advance();
      }
      return null;
    }

    const start = this.cur();
    const names: string[] = [this.advance().value];
    while (this.match(TT.COMMA)) {
      names.push(this.expect(TT.IDENT, 'Expected variable name').value);
    }
    this.expect(TT.COLON, "Expected ':' after variable name(s)");
    const type = this.parseTypeNode();
    let initialValue: Expression | undefined;
    if (this.match(TT.ASSIGN)) {
      initialValue = this.parseExpression();
    }
    this.expect(TT.SEMICOLON, "Expected ';' after variable declaration");

    return { kind: 'varDeclaration', names, type, initialValue, location: this.loc(start) };
  }

  // ── Type Nodes ────────────────────────────────────────────────────────

  private parseTypeNode(): TypeNode {
    const start = this.cur();

    // ARRAY
    if (this.check(TT.ARRAY)) {
      return this.parseArrayType();
    }

    // STRING / WSTRING with optional [maxLength]
    if (this.check(TT.STRING_KW) || this.check(TT.WSTRING)) {
      const baseType = this.advance().value.toUpperCase() as 'STRING' | 'WSTRING';
      let maxLength: number | undefined;
      if (this.match(TT.LBRACKET)) {
        const lenTok = this.expect(TT.INTEGER, 'Expected string max length');
        maxLength = parseInt(lenTok.value, 10);
        this.expect(TT.RBRACKET, "Expected ']'");
      }
      return { kind: 'stringType', baseType, maxLength, location: this.loc(start) } as TypeNode;
    }

    // Elementary types
    if (DATA_TYPE_TOKENS.has(this.cur().type)) {
      const tok = this.advance();
      return { kind: 'elementaryType', name: tok.value.toUpperCase(), location: this.loc(start) };
    }

    // Named type (user-defined)
    if (this.check(TT.IDENT)) {
      const tok = this.advance();
      return { kind: 'namedType', name: tok.value, location: this.loc(start) };
    }

    this.addError(`Expected type, got '${this.cur().value}'`);
    return { kind: 'elementaryType', name: 'INT', location: this.loc(start) };
  }

  private parseArrayType(): TypeNode {
    const start = this.advance(); // consume ARRAY
    this.expect(TT.LBRACKET, "Expected '[' after ARRAY");
    const dimensions: { lower: Expression; upper: Expression }[] = [];

    // First dimension
    const lower = this.parseExpression();
    this.expect(TT.DOTDOT, "Expected '..' in array dimension");
    const upper = this.parseExpression();
    dimensions.push({ lower, upper });

    // Additional dimensions
    while (this.match(TT.COMMA)) {
      const lo = this.parseExpression();
      this.expect(TT.DOTDOT, "Expected '..' in array dimension");
      const up = this.parseExpression();
      dimensions.push({ lower: lo, upper: up });
    }

    this.expect(TT.RBRACKET, "Expected ']' after array dimensions");
    this.expect(TT.OF, "Expected 'OF' after array dimensions");
    const elementType = this.parseTypeNode();

    return { kind: 'arrayType', dimensions, elementType, location: this.loc(start) };
  }

  // ── Statement List ────────────────────────────────────────────────────

  private parseStatementList(...endTokens: TT[]): Statement[] {
    const stmts: Statement[] = [];
    while (!this.isAtEnd() && !endTokens.includes(this.cur().type) && this.errors.length < this.MAX_ERRORS) {
      // Also bail out on ELSE, ELSIF which are handled by parent
      if (this.checkAny(TT.ELSE, TT.ELSIF)) break;
      const stmt = this.parseStatement();
      if (stmt) stmts.push(stmt);
    }
    return stmts;
  }

  // ── Statements ────────────────────────────────────────────────────────

  private parseStatement(): Statement | null {
    // Skip bare semicolons
    if (this.match(TT.SEMICOLON)) {
      return { kind: 'emptyStatement', location: this.loc(this.prev()) };
    }

    const t = this.cur().type;

    if (t === TT.IF) return this.parseIf();
    if (t === TT.CASE) return this.parseCase();
    if (t === TT.FOR) return this.parseFor();
    if (t === TT.WHILE) return this.parseWhile();
    if (t === TT.REPEAT) return this.parseRepeat();
    if (t === TT.RETURN) { const s = this.advance(); this.match(TT.SEMICOLON); return { kind: 'returnStatement', location: this.loc(s) }; }
    if (t === TT.EXIT) { const s = this.advance(); this.match(TT.SEMICOLON); return { kind: 'exitStatement', location: this.loc(s) }; }

    // Assignment or expression statement
    if (t === TT.IDENT || t === TT.NOT || t === TT.MINUS || t === TT.PLUS || t === TT.LPAREN) {
      return this.parseAssignmentOrExprStmt();
    }

    // Unexpected token - try to recover
    this.addError(`Unexpected token '${this.cur().value}' at start of statement`);
    this.syncToSemicolon();
    return null;
  }

  private parseAssignmentOrExprStmt(): Statement {
    const start = this.cur();
    const expr = this.parseExpression();

    if (this.match(TT.ASSIGN)) {
      const value = this.parseExpression();
      this.match(TT.SEMICOLON);
      return { kind: 'assignment', target: expr, value, location: this.loc(start) };
    }

    // Expression statement (function call as statement, etc.)
    this.match(TT.SEMICOLON);
    return { kind: 'expressionStatement', expression: expr, location: this.loc(start) };
  }

  // ── IF ────────────────────────────────────────────────────────────────

  private parseIf(): IfStatement {
    this.depth++;
    if (this.depth > this.MAX_DEPTH) { this.addError('Maximum nesting depth exceeded'); }
    const start = this.advance(); // consume IF
    const condition = this.parseExpression();
    this.expect(TT.THEN, "Expected 'THEN'");
    const thenBody = this.parseStatementList(TT.END_IF, TT.ELSIF, TT.ELSE);

    const elsifBranches: ElsifBranch[] = [];
    while (this.match(TT.ELSIF)) {
      const elsifStart = this.prev();
      const elsifCond = this.parseExpression();
      this.expect(TT.THEN, "Expected 'THEN' after ELSIF condition");
      const elsifBody = this.parseStatementList(TT.END_IF, TT.ELSIF, TT.ELSE);
      elsifBranches.push({ condition: elsifCond, body: elsifBody, location: this.loc(elsifStart) });
    }

    let elseBody: Statement[] | undefined;
    if (this.match(TT.ELSE)) {
      elseBody = this.parseStatementList(TT.END_IF);
    }

    this.expect(TT.END_IF, "Expected 'END_IF'");
    this.match(TT.SEMICOLON);
    this.depth--;
    return { kind: 'ifStatement', condition, thenBody, elsifBranches, elseBody, location: this.loc(start) };
  }

  // ── CASE ──────────────────────────────────────────────────────────────

  private parseCase(): CaseStatement {
    this.depth++;
    if (this.depth > this.MAX_DEPTH) { this.addError('Maximum nesting depth exceeded'); }
    const start = this.advance(); // consume CASE
    const expression = this.parseExpression();
    this.expect(TT.OF, "Expected 'OF'");

    const cases: CaseBranch[] = [];
    let elseBody: Statement[] | undefined;

    while (!this.isAtEnd() && !this.check(TT.END_CASE) && !this.check(TT.ELSE)) {
      // Parse case labels
      const labels: CaseLabel[] = [];
      do {
        const labelExpr = this.parseExpression();
        if (this.match(TT.DOTDOT)) {
          const upper = this.parseExpression();
          labels.push({ kind: 'range', lower: labelExpr, upper });
        } else {
          labels.push({ kind: 'single', value: labelExpr });
        }
      } while (this.match(TT.COMMA));

      const labelStart = this.cur();
      this.expect(TT.COLON, "Expected ':' after case label(s)");
      const body = this.parseCaseBody();
      cases.push({ labels, body, location: this.loc(labelStart) });
    }

    if (this.match(TT.ELSE)) {
      elseBody = this.parseStatementList(TT.END_CASE);
    }

    this.expect(TT.END_CASE, "Expected 'END_CASE'");
    this.match(TT.SEMICOLON);
    this.depth--;
    return { kind: 'caseStatement', expression, cases, elseBody, location: this.loc(start) };
  }

  private parseCaseBody(): Statement[] {
    const stmts: Statement[] = [];
    while (!this.isAtEnd()) {
      // End of this case branch: next label, ELSE, or END_CASE
      if (this.check(TT.END_CASE) || this.check(TT.ELSE)) break;
      // Heuristic: integer/identifier followed by colon or comma = new label
      if (this.isLabelStart()) break;
      const stmt = this.parseStatement();
      if (stmt) stmts.push(stmt);
    }
    return stmts;
  }

  /** Check if current position looks like a case label start (number: or ident:) */
  private isLabelStart(): boolean {
    // Look for patterns like "NUMBER :" or "NUMBER , NUMBER :" or "NUMBER .. NUMBER :"
    if (!this.checkAny(TT.INTEGER, TT.IDENT, TT.MINUS, TT.HEX_LIT)) return false;

    // Scan ahead to find colon within the label expression
    let look = 0;
    let depth = 0;
    while (this.pos + look < this.tokens.length) {
      const t = this.tokens[this.pos + look]!.type;
      if (t === TT.COLON && depth === 0) return true;
      if (t === TT.SEMICOLON || t === TT.END_CASE || t === TT.ELSE || t === TT.EOF) return false;
      if (t === TT.ASSIGN) return false; // this is an assignment, not a label
      if (t === TT.LPAREN) depth++;
      if (t === TT.RPAREN) depth--;
      look++;
      if (look > 20) return false; // safety: don't look too far
    }
    return false;
  }

  // ── FOR ───────────────────────────────────────────────────────────────

  private parseFor(): ForStatement {
    this.depth++;
    if (this.depth > this.MAX_DEPTH) { this.addError('Maximum nesting depth exceeded'); }
    const start = this.advance(); // consume FOR
    const variable = this.expect(TT.IDENT, 'Expected loop variable').value;
    this.expect(TT.ASSIGN, "Expected ':=' after loop variable");
    const from = this.parseExpression();
    this.expect(TT.TO, "Expected 'TO'");
    const to = this.parseExpression();
    let by: Expression | undefined;
    if (this.match(TT.BY)) {
      by = this.parseExpression();
    }
    this.expect(TT.DO, "Expected 'DO'");
    const body = this.parseStatementList(TT.END_FOR);
    this.expect(TT.END_FOR, "Expected 'END_FOR'");
    this.match(TT.SEMICOLON);
    this.depth--;
    return { kind: 'forStatement', variable, from, to, by, body, location: this.loc(start) };
  }

  // ── WHILE ─────────────────────────────────────────────────────────────

  private parseWhile(): WhileStatement {
    this.depth++;
    if (this.depth > this.MAX_DEPTH) { this.addError('Maximum nesting depth exceeded'); }
    const start = this.advance(); // consume WHILE
    const condition = this.parseExpression();
    this.expect(TT.DO, "Expected 'DO'");
    const body = this.parseStatementList(TT.END_WHILE);
    this.expect(TT.END_WHILE, "Expected 'END_WHILE'");
    this.match(TT.SEMICOLON);
    this.depth--;
    return { kind: 'whileStatement', condition, body, location: this.loc(start) };
  }

  // ── REPEAT ────────────────────────────────────────────────────────────

  private parseRepeat(): RepeatStatement {
    this.depth++;
    if (this.depth > this.MAX_DEPTH) { this.addError('Maximum nesting depth exceeded'); }
    const start = this.advance(); // consume REPEAT
    const body = this.parseStatementList(TT.UNTIL);
    this.expect(TT.UNTIL, "Expected 'UNTIL'");
    const condition = this.parseExpression();
    this.match(TT.SEMICOLON);
    this.expect(TT.END_REPEAT, "Expected 'END_REPEAT'");
    this.match(TT.SEMICOLON);
    this.depth--;
    return { kind: 'repeatStatement', body, condition, location: this.loc(start) };
  }

  // ════════════════════════════════════════════════════════════════════════
  // Expressions — Pratt Precedence Climbing
  // ════════════════════════════════════════════════════════════════════════

  private parseExpression(minPrec = 0): Expression {
    let left = this.parsePrefixExpression();

    while (!this.isAtEnd()) {
      const tt = this.cur().type;
      const prec = getPrec(tt);
      if (prec <= minPrec) break;

      const op = toBinOp(tt);
      if (!op) break;

      const opTok = this.advance(); // consume operator

      // Right-associative for **
      const nextMinPrec = tt === TT.POWER ? prec - 1 : prec;
      const right = this.parseExpression(nextMinPrec);

      left = {
        kind: 'binaryExpression', operator: op,
        left, right, location: this.loc(opTok),
      };
    }

    return left;
  }

  private parsePrefixExpression(): Expression {
    const t = this.cur();

    // Unary NOT
    if (t.type === TT.NOT) {
      const start = this.advance();
      const operand = this.parsePrefixExpression();
      return { kind: 'unaryExpression', operator: 'NOT' as UnaryOperator, operand, location: this.loc(start) };
    }

    // Unary minus / plus
    if (t.type === TT.MINUS || t.type === TT.PLUS) {
      // Distinguish unary minus from binary:
      // unary minus applies at prefix position (start of expression, after operator, after '(', etc.)
      const start = this.advance();
      const operand = this.parsePrefixExpression();
      const op: UnaryOperator = start.value === '-' ? '-' : '+';
      return { kind: 'unaryExpression', operator: op, operand, location: this.loc(start) };
    }

    return this.parsePostfixExpression();
  }

  private parsePostfixExpression(): Expression {
    let expr = this.parsePrimary();

    // Postfix: member access, array access, function call
    while (!this.isAtEnd()) {
      if (this.check(TT.DOT)) {
        this.advance(); // consume .
        const member = this.expect(TT.IDENT, 'Expected member name after .').value;
        expr = { kind: 'memberAccess', object: expr, member, location: this.loc(expr as any) };
      } else if (this.check(TT.LBRACKET)) {
        this.advance(); // consume [
        const indices: Expression[] = [this.parseExpression()];
        while (this.match(TT.COMMA)) indices.push(this.parseExpression());
        this.expect(TT.RBRACKET, "Expected ']'");
        expr = { kind: 'arrayAccess', array: expr, indices, location: this.loc(expr as any) };
      } else {
        break;
      }
    }

    return expr;
  }

  private parsePrimary(): Expression {
    const t = this.cur();
    const start = t;

    // Parenthesized expression
    if (t.type === TT.LPAREN) {
      this.advance();
      const inner = this.parseExpression();
      this.expect(TT.RPAREN, "Expected ')'");
      return { kind: 'parenthesized', expression: inner, location: this.loc(start) };
    }

    // Integer literal
    if (t.type === TT.INTEGER) {
      this.advance();
      return { kind: 'integerLiteral', value: parseInt(t.value, 10), raw: t.value, location: this.loc(start) };
    }

    // Hex literal (16#FF)
    if (t.type === TT.HEX_LIT) {
      this.advance();
      const hexPart = t.value.substring(t.value.indexOf('#') + 1);
      return { kind: 'integerLiteral', value: parseInt(hexPart, 16), raw: t.value, location: this.loc(start) };
    }

    // Real literal
    if (t.type === TT.REAL) {
      this.advance();
      return { kind: 'realLiteral', value: parseFloat(t.value), raw: t.value, location: this.loc(start) };
    }

    // String literal
    if (t.type === TT.STRING_LIT) {
      this.advance();
      return { kind: 'stringLiteral', value: t.value, raw: t.value, location: this.loc(start) };
    }

    // Boolean literal
    if (t.type === TT.BOOL_TRUE) {
      this.advance();
      return { kind: 'booleanLiteral', value: true, raw: t.value, location: this.loc(start) };
    }
    if (t.type === TT.BOOL_FALSE) {
      this.advance();
      return { kind: 'booleanLiteral', value: false, raw: t.value, location: this.loc(start) };
    }

    // Time literal
    if (t.type === TT.TIME_LIT) {
      this.advance();
      return { kind: 'timeLiteral', raw: t.value, location: this.loc(start) };
    }

    // Identifier — possibly function call
    if (t.type === TT.IDENT) {
      this.advance();
      const name = t.value;

      // Function call: IDENT(...)
      if (this.check(TT.LPAREN)) {
        return this.parseFunctionCallArgs(name, start);
      }

      return { kind: 'identifier', name, location: this.loc(start) };
    }

    this.addError(`Unexpected token '${t.value}' in expression`);
    this.advance(); // skip to avoid infinite loop
    return { kind: 'identifier', name: '__error__', location: this.loc(start) };
  }

  private parseFunctionCallArgs(name: string, start: Token): Expression {
    this.advance(); // consume (
    const args: Expression[] = [];
    const namedArgs: NamedArgument[] = [];

    if (!this.check(TT.RPAREN)) {
      this.parseFunctionArg(args, namedArgs);
      while (this.match(TT.COMMA)) {
        this.parseFunctionArg(args, namedArgs);
      }
    }

    this.expect(TT.RPAREN, "Expected ')' after function arguments");

    return {
      kind: 'functionCall', name, args, namedArgs,
      location: this.loc(start),
    };
  }

  private parseFunctionArg(args: Expression[], namedArgs: NamedArgument[]): void {
    // Check for named argument: IDENT := expr or IDENT => expr
    if (this.check(TT.IDENT) && (this.peekAt(1).type === TT.ASSIGN || this.peekAt(1).type === TT.ARROW)) {
      const argStart = this.cur();
      const argName = this.advance().value;
      const assignType: 'input' | 'output' = this.cur().type === TT.ARROW ? 'output' : 'input';
      this.advance(); // consume := or =>
      const value = this.parseExpression();
      namedArgs.push({ name: argName, value, assignType, location: this.loc(argStart) } as NamedArgument);
    } else {
      args.push(this.parseExpression());
    }
  }
}
