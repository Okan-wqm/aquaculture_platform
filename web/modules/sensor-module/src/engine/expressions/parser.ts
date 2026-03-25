/**
 * Recursive descent parser producing an Abstract Syntax Tree (AST)
 * from the token stream. Implements operator precedence via separate
 * parsing functions for each precedence level.
 *
 * Grammar (from lowest to highest precedence):
 *   expr       -> ternary
 *   ternary    -> logicalOr ('?' expr ':' expr)?
 *   logicalOr  -> logicalAnd ('||' logicalAnd)*
 *   logicalAnd -> equality ('&&' equality)*
 *   equality   -> comparison (('=='|'!=') comparison)*
 *   comparison -> addition (('<'|'>'|'<='|'>=') addition)*
 *   addition   -> multiply (('+'|'-') multiply)*
 *   multiply   -> power (('*'|'/'|'%') power)*
 *   power      -> unary ('**' unary)*
 *   unary      -> ('!'|'-') unary | call
 *   call       -> primary ('(' args ')')?
 *   primary    -> number | tagRef | identifier | '(' expr ')'
 *
 * Security: The parser produces a static AST — no code generation,
 * no eval, no dynamic dispatch. The evaluator walks the AST with
 * a fixed set of built-in functions only.
 */

import { tokenize, type Token, type TokenType } from './tokenizer';

// -- AST node types --

export type ASTNode =
  | NumberNode
  | TagRefNode
  | IdentifierNode
  | BinaryNode
  | UnaryNode
  | CallNode
  | TernaryNode;

export interface NumberNode {
  type: 'number';
  value: number;
}

export interface TagRefNode {
  type: 'tagRef';
  name: string;
}

export interface IdentifierNode {
  type: 'identifier';
  name: string;
}

export interface BinaryNode {
  type: 'binary';
  operator: string;
  left: ASTNode;
  right: ASTNode;
}

export interface UnaryNode {
  type: 'unary';
  operator: string;
  operand: ASTNode;
}

export interface CallNode {
  type: 'call';
  name: string;
  args: ASTNode[];
}

export interface TernaryNode {
  type: 'ternary';
  condition: ASTNode;
  consequent: ASTNode;
  alternate: ASTNode;
}

export interface ParseResult {
  ast: ASTNode | null;
  error: string | null;
  /** Tag names referenced in the expression (both ${tag} and bare identifiers) */
  dependencies: string[];
}

/**
 * Parse an expression string into an AST with dependency extraction.
 *
 * This is the main entry point. It tokenizes the input, then runs
 * the recursive descent parser. Dependencies are collected during
 * the parse walk — any tagRef node or identifier node that is NOT
 * used as a function call name is treated as a tag dependency.
 */
export function parse(input: string): ParseResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ast: null, error: 'Empty expression', dependencies: [] };
  }

  const tokens = tokenize(trimmed);

  // Check for tokenizer errors
  const errorToken = tokens.find((t) => t.type === 'error');
  if (errorToken) {
    return { ast: null, error: errorToken.value, dependencies: [] };
  }

  const state = new ParserState(tokens);

  try {
    const ast = parseExpression(state);

    // Ensure we consumed all tokens (except eof)
    if (!state.isAtEnd()) {
      const unexpected = state.peek();
      return {
        ast: null,
        error: `Unexpected token '${unexpected.value}' at position ${unexpected.position}`,
        dependencies: Array.from(state.dependencies),
      };
    }

    return {
      ast,
      error: null,
      dependencies: Array.from(state.dependencies),
    };
  } catch (err: unknown) {
    const message = err instanceof ParseError ? err.message : String(err);
    return { ast: null, error: message, dependencies: Array.from(state.dependencies) };
  }
}

/**
 * Extract tag dependencies from an already-parsed AST.
 * Useful when you have an AST from a previous parse and need
 * to re-extract dependencies without re-parsing.
 */
export function extractDependencies(ast: ASTNode): string[] {
  const deps = new Set<string>();
  walkDependencies(ast, deps);
  return Array.from(deps);
}

// -- Internal parser state --

class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

class ParserState {
  readonly tokens: Token[];
  readonly dependencies: Set<string> = new Set();
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token {
    return this.tokens[this.pos];
  }

  advance(): Token {
    const token = this.tokens[this.pos];
    if (token.type !== 'eof') this.pos++;
    return token;
  }

  isAtEnd(): boolean {
    return this.peek().type === 'eof';
  }

  expect(type: TokenType, value?: string): Token {
    const token = this.peek();
    if (token.type !== type || (value !== undefined && token.value !== value)) {
      const expected = value ? `'${value}'` : type;
      throw new ParseError(
        `Expected ${expected} at position ${token.position}, got '${token.value}'`,
      );
    }
    return this.advance();
  }

  matchOperator(...operators: string[]): Token | null {
    const token = this.peek();
    if (token.type === 'operator' && operators.includes(token.value)) {
      return this.advance();
    }
    return null;
  }
}

// -- Recursive descent parsing functions (one per precedence level) --

function parseExpression(state: ParserState): ASTNode {
  return parseTernary(state);
}

function parseTernary(state: ParserState): ASTNode {
  const condition = parseLogicalOr(state);

  if (state.peek().type === 'question') {
    state.advance(); // consume '?'
    const consequent = parseExpression(state);
    state.expect('colon');
    const alternate = parseExpression(state);
    return { type: 'ternary', condition, consequent, alternate };
  }

  return condition;
}

function parseLogicalOr(state: ParserState): ASTNode {
  let left = parseLogicalAnd(state);

  while (state.matchOperator('||')) {
    const right = parseLogicalAnd(state);
    left = { type: 'binary', operator: '||', left, right };
  }

  return left;
}

function parseLogicalAnd(state: ParserState): ASTNode {
  let left = parseEquality(state);

  while (state.matchOperator('&&')) {
    const right = parseEquality(state);
    left = { type: 'binary', operator: '&&', left, right };
  }

  return left;
}

function parseEquality(state: ParserState): ASTNode {
  let left = parseComparison(state);

  let op: Token | null;
  while ((op = state.matchOperator('==', '!='))) {
    const right = parseComparison(state);
    left = { type: 'binary', operator: op.value, left, right };
  }

  return left;
}

function parseComparison(state: ParserState): ASTNode {
  let left = parseAddition(state);

  let op: Token | null;
  while ((op = state.matchOperator('<', '>', '<=', '>='))) {
    const right = parseAddition(state);
    left = { type: 'binary', operator: op.value, left, right };
  }

  return left;
}

function parseAddition(state: ParserState): ASTNode {
  let left = parseMultiply(state);

  let op: Token | null;
  while ((op = state.matchOperator('+', '-'))) {
    const right = parseMultiply(state);
    left = { type: 'binary', operator: op.value, left, right };
  }

  return left;
}

function parseMultiply(state: ParserState): ASTNode {
  let left = parsePower(state);

  let op: Token | null;
  while ((op = state.matchOperator('*', '/', '%'))) {
    const right = parsePower(state);
    left = { type: 'binary', operator: op.value, left, right };
  }

  return left;
}

/**
 * Power operator is right-associative: 2**3**2 = 2**(3**2) = 512.
 * We implement this by recursing into parsePower for the right operand.
 */
function parsePower(state: ParserState): ASTNode {
  const base = parseUnary(state);

  if (state.matchOperator('**')) {
    const exponent = parsePower(state); // right-associative recursion
    return { type: 'binary', operator: '**', left: base, right: exponent };
  }

  return base;
}

function parseUnary(state: ParserState): ASTNode {
  const op = state.matchOperator('!', '-');
  if (op) {
    const operand = parseUnary(state);
    return { type: 'unary', operator: op.value, operand };
  }

  return parseCall(state);
}

/**
 * Parse a function call: identifier '(' args ')'.
 * Only identifier tokens can be call targets — this prevents
 * arbitrary expression invocation.
 */
function parseCall(state: ParserState): ASTNode {
  const primary = parsePrimary(state);

  // Function call: the primary must be an identifier
  if (primary.type === 'identifier' && state.peek().type === 'leftParen') {
    state.advance(); // consume '('

    // The identifier is a function name, remove it from tag dependencies
    state.dependencies.delete(primary.name);

    const args: ASTNode[] = [];

    if (state.peek().type !== 'rightParen') {
      args.push(parseExpression(state));
      while (state.peek().type === 'comma') {
        state.advance(); // consume ','
        args.push(parseExpression(state));
      }
    }

    state.expect('rightParen');
    return { type: 'call', name: primary.name, args };
  }

  return primary;
}

function parsePrimary(state: ParserState): ASTNode {
  const token = state.peek();

  // Number literal
  if (token.type === 'number') {
    state.advance();
    return { type: 'number', value: parseFloat(token.value) };
  }

  // Tag reference: ${tagName}
  if (token.type === 'tagRef') {
    state.advance();
    state.dependencies.add(token.value);
    return { type: 'tagRef', name: token.value };
  }

  // Identifier: could be a bare tag name or a function name
  // Function call detection happens in parseCall() above
  if (token.type === 'identifier') {
    state.advance();
    state.dependencies.add(token.value);
    return { type: 'identifier', name: token.value };
  }

  // Parenthesized sub-expression
  if (token.type === 'leftParen') {
    state.advance(); // consume '('
    const expr = parseExpression(state);
    state.expect('rightParen');
    return expr;
  }

  throw new ParseError(
    `Unexpected token '${token.value}' at position ${token.position}`,
  );
}

// -- Dependency extraction walker --

function walkDependencies(node: ASTNode, deps: Set<string>): void {
  switch (node.type) {
    case 'number':
      break;
    case 'tagRef':
      deps.add(node.name);
      break;
    case 'identifier':
      deps.add(node.name);
      break;
    case 'binary':
      walkDependencies(node.left, deps);
      walkDependencies(node.right, deps);
      break;
    case 'unary':
      walkDependencies(node.operand, deps);
      break;
    case 'call':
      // Function name is NOT a dependency — only its arguments are
      for (const arg of node.args) {
        walkDependencies(arg, deps);
      }
      break;
    case 'ternary':
      walkDependencies(node.condition, deps);
      walkDependencies(node.consequent, deps);
      walkDependencies(node.alternate, deps);
      break;
  }
}
