/**
 * Expression validation and evaluation utilities for the ExpressionEditor.
 *
 * These are lightweight client-side helpers that work independently of the
 * Phase 4A expression engine (engine/expressions/*). When that engine lands,
 * the validation and evaluation functions here can delegate to the real parser
 * and evaluator for full semantic accuracy. Until then, these provide
 * structural validation (balanced braces/parens, non-empty refs) and
 * simple substitution-based preview evaluation.
 */

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

/**
 * Minimal validation result type -- mirrors the shape that
 * engine/expressions/parser.ts will expose. Defined locally so the
 * editor builds even before the Phase 4A parser lands.
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
  position?: number;
  dependencies: string[];
}

export interface EvaluationResult {
  value: string;
  error?: string;
}

/* ------------------------------------------------------------------ */
/*  Tag reference extraction                                            */
/* ------------------------------------------------------------------ */

/** Regex to extract ${tagName} references from an expression string */
const TAG_REF_RE = /\$\{([^}]+)\}/g;

/**
 * Extract referenced tag names from an expression.
 * Works independently of the parser so autocomplete and badge display
 * function even before Phase 4A merges.
 */
export function extractDependencies(expr: string): string[] {
  const deps = new Set<string>();
  let match: RegExpExecArray | null;
  const re = new RegExp(TAG_REF_RE.source, 'g');
  while ((match = re.exec(expr)) !== null) {
    deps.add(match[1]);
  }
  return Array.from(deps);
}

/* ------------------------------------------------------------------ */
/*  Structural validation                                               */
/* ------------------------------------------------------------------ */

/**
 * Lightweight validation that checks basic syntax:
 * - Balanced parentheses and braces
 * - No empty tag references ${}
 *
 * When the Phase 4A parser is available, this should be replaced with
 * a full AST parse pass that catches semantic errors too.
 */
export function validateExpression(expr: string): ValidationResult {
  const deps = extractDependencies(expr);

  if (!expr.trim()) {
    return { valid: false, error: 'Expression is empty', dependencies: deps };
  }

  // Check for empty tag references
  if (/\$\{\s*\}/.test(expr)) {
    const pos = expr.indexOf('${}');
    return {
      valid: false,
      error: 'Empty tag reference',
      position: pos >= 0 ? pos : undefined,
      dependencies: deps,
    };
  }

  // Check balanced braces
  let braceDepth = 0;
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === '{') braceDepth++;
    if (expr[i] === '}') braceDepth--;
    if (braceDepth < 0) {
      return { valid: false, error: 'Unmatched closing brace', position: i, dependencies: deps };
    }
  }
  if (braceDepth > 0) {
    return { valid: false, error: 'Unclosed brace', dependencies: deps };
  }

  // Check balanced parentheses
  let parenDepth = 0;
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === '(') parenDepth++;
    if (expr[i] === ')') parenDepth--;
    if (parenDepth < 0) {
      return {
        valid: false,
        error: 'Unmatched closing parenthesis',
        position: i,
        dependencies: deps,
      };
    }
  }
  if (parenDepth > 0) {
    return { valid: false, error: 'Unclosed parenthesis', dependencies: deps };
  }

  return { valid: true, dependencies: deps };
}

/* ------------------------------------------------------------------ */
/*  Preview evaluation                                                  */
/* ------------------------------------------------------------------ */

/** Maximum expression length to prevent ReDoS or excessive parse time */
const MAX_EXPRESSION_LENGTH = 500;

/**
 * Allowlisted math functions that the safe evaluator supports.
 * Maps function name to its implementation.
 */
const SAFE_FUNCTIONS: Record<string, (...args: number[]) => number> = {
  abs: Math.abs,
  sqrt: Math.sqrt,
  pow: Math.pow,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  log: Math.log,
  exp: Math.exp,
  min: Math.min,
  max: Math.max,
};

/**
 * Identifiers that MUST NOT appear in expressions. These are dangerous
 * globals that could be used for code injection or sandbox escape.
 */
const BLOCKED_IDENTIFIERS = new Set([
  'window', 'document', 'eval', 'Function', 'require', 'import',
  'fetch', 'XMLHttpRequest', '__proto__', 'constructor', 'prototype',
  'globalThis', 'self', 'top', 'parent', 'frames', 'location',
  'navigator', 'process', 'module', 'exports', 'setTimeout',
  'setInterval', 'alert', 'confirm', 'prompt',
]);

/* ------------------------------------------------------------------ */
/*  Tokenizer                                                           */
/* ------------------------------------------------------------------ */

/** Token types produced by the expression tokenizer */
type TokenType = 'number' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma' | 'eof';

interface Token {
  type: TokenType;
  value: string;
  numericValue?: number;
}

/**
 * Tokenizes a mathematical expression string into a flat token array.
 * Only recognizes: numbers (including decimals), identifiers (a-zA-Z_),
 * arithmetic operators (+, -, *, /, %), parentheses, and commas.
 *
 * Throws on any unrecognized character, preventing injection of
 * semicolons, backticks, brackets, or other dangerous syntax.
 */
function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expr.length) {
    const ch = expr[i];

    // Skip whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    // Numbers: integers and decimals (e.g., 3.14, .5, 42)
    if ((ch >= '0' && ch <= '9') || (ch === '.' && i + 1 < expr.length && expr[i + 1] >= '0' && expr[i + 1] <= '9')) {
      let num = '';
      let hasDot = false;
      while (i < expr.length && ((expr[i] >= '0' && expr[i] <= '9') || (expr[i] === '.' && !hasDot))) {
        if (expr[i] === '.') hasDot = true;
        num += expr[i];
        i++;
      }
      tokens.push({ type: 'number', value: num, numericValue: parseFloat(num) });
      continue;
    }

    // Identifiers: variable names and function names (a-zA-Z_)
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      let ident = '';
      while (i < expr.length && ((expr[i] >= 'a' && expr[i] <= 'z') || (expr[i] >= 'A' && expr[i] <= 'Z') || (expr[i] >= '0' && expr[i] <= '9') || expr[i] === '_')) {
        ident += expr[i];
        i++;
      }
      tokens.push({ type: 'ident', value: ident });
      continue;
    }

    // Operators
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%') {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }

    // Parentheses
    if (ch === '(') { tokens.push({ type: 'lparen', value: '(' }); i++; continue; }
    if (ch === ')') { tokens.push({ type: 'rparen', value: ')' }); i++; continue; }

    // Comma (for function arguments)
    if (ch === ',') { tokens.push({ type: 'comma', value: ',' }); i++; continue; }

    throw new Error(`Invalid character '${ch}' at position ${i}`);
  }

  tokens.push({ type: 'eof', value: '' });
  return tokens;
}

/* ------------------------------------------------------------------ */
/*  Recursive descent parser + evaluator                                */
/* ------------------------------------------------------------------ */

/**
 * SEC-L16: Safe mathematical expression evaluator replacing new Function().
 *
 * new Function() is equivalent to eval() and allows arbitrary code execution.
 * This evaluator uses a recursive descent parser that only supports arithmetic
 * operations on known variable names and allowlisted math functions, preventing
 * code injection even if user-controlled data reaches the expression.
 *
 * Supported: numbers, +, -, *, /, %, parentheses, variable references,
 *            allowlisted functions (abs, sqrt, pow, round, floor, ceil,
 *            log, exp, min, max), clamp(val, min, max)
 * Blocked: function calls to unknown functions, property access, assignment,
 *          dangerous globals (window, document, eval, Function, etc.)
 *
 * Grammar:
 *   expr     -> term (('+' | '-') term)*
 *   term     -> unary (('*' | '/' | '%') unary)*
 *   unary    -> ('-' | '+')? primary
 *   primary  -> NUMBER | IDENT '(' arglist ')' | IDENT | '(' expr ')'
 *   arglist  -> expr (',' expr)*
 */
function safeEvaluateExpression(
  expression: string,
  variables: Record<string, number>,
): number {
  const tokens = tokenize(expression);
  let pos = 0;

  /** Returns the current token without advancing */
  function peek(): Token {
    return tokens[pos];
  }

  /** Returns the current token and advances to the next */
  function advance(): Token {
    return tokens[pos++];
  }

  /** Expects the current token to be of a specific type, then advances */
  function expect(type: TokenType): Token {
    const tok = peek();
    if (tok.type !== type) {
      throw new Error(`Expected ${type}, got ${tok.type} '${tok.value}'`);
    }
    return advance();
  }

  /** expr -> term (('+' | '-') term)* */
  function parseExpr(): number {
    let result = parseTerm();
    while (peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = advance().value;
      const right = parseTerm();
      result = op === '+' ? result + right : result - right;
    }
    return result;
  }

  /** term -> unary (('*' | '/' | '%') unary)* */
  function parseTerm(): number {
    let result = parseUnary();
    while (peek().type === 'op' && (peek().value === '*' || peek().value === '/' || peek().value === '%')) {
      const op = advance().value;
      const right = parseUnary();
      if (op === '*') result = result * right;
      else if (op === '/') result = right === 0 ? NaN : result / right;
      else result = right === 0 ? NaN : result % right;
    }
    return result;
  }

  /** unary -> ('-' | '+')? primary */
  function parseUnary(): number {
    if (peek().type === 'op' && (peek().value === '-' || peek().value === '+')) {
      const op = advance().value;
      const val = parsePrimary();
      return op === '-' ? -val : val;
    }
    return parsePrimary();
  }

  /** primary -> NUMBER | IDENT '(' arglist ')' | IDENT | '(' expr ')' */
  function parsePrimary(): number {
    const tok = peek();

    // Number literal
    if (tok.type === 'number') {
      advance();
      return tok.numericValue as number;
    }

    // Identifier: either a function call or a variable reference
    if (tok.type === 'ident') {
      const name = advance().value;

      // Block dangerous identifiers
      if (BLOCKED_IDENTIFIERS.has(name)) {
        throw new Error(`Blocked identifier '${name}'`);
      }

      // Function call: ident '(' arglist ')'
      if (peek().type === 'lparen') {
        advance(); // consume '('
        const args: number[] = [];

        if (peek().type !== 'rparen') {
          args.push(parseExpr());
          while (peek().type === 'comma') {
            advance(); // consume ','
            args.push(parseExpr());
          }
        }
        expect('rparen');

        // Handle clamp(val, min, max) as a special composite function
        if (name === 'clamp') {
          if (args.length !== 3) throw new Error('clamp() requires exactly 3 arguments');
          return Math.min(Math.max(args[0], args[1]), args[2]);
        }

        const fn = SAFE_FUNCTIONS[name];
        if (!fn) throw new Error(`Unknown function '${name}'`);
        return fn(...args);
      }

      // Variable reference
      const val = variables[name];
      if (val === undefined) return NaN;
      return val;
    }

    // Parenthesized expression
    if (tok.type === 'lparen') {
      advance(); // consume '('
      const result = parseExpr();
      expect('rparen');
      return result;
    }

    throw new Error(`Unexpected token '${tok.value}'`);
  }

  const result = parseExpr();

  // Ensure all tokens have been consumed (no trailing garbage)
  if (peek().type !== 'eof') {
    throw new Error(`Unexpected token '${peek().value}' after expression`);
  }

  return result;
}

/**
 * Attempt to evaluate an expression with the given tag values.
 *
 * SEC-L16: Uses a safe recursive descent parser instead of new Function().
 * Only arithmetic operations and allowlisted math functions are supported.
 * The evaluator never executes arbitrary JavaScript, preventing code
 * injection even if user-controlled data reaches the expression.
 */
export function tryEvaluate(
  expr: string,
  tagValues: Record<string, number | string | boolean>,
): EvaluationResult {
  try {
    // SEC-L16: Enforce maximum expression length to prevent abuse
    if (expr.length > MAX_EXPRESSION_LENGTH) {
      return { value: '?', error: `Expression exceeds ${MAX_EXPRESSION_LENGTH} character limit` };
    }

    // Replace tag references ${tagName} with their values.
    // Non-numeric values become NaN; undefined tags also become NaN.
    const substituted = expr.replace(TAG_REF_RE, (_, tagName: string) => {
      const val = tagValues[tagName];
      if (val === undefined) return 'NaN';
      const num = Number(val);
      return Number.isNaN(num) ? 'NaN' : String(num);
    });

    // Build a variables map for any remaining identifiers in the expression
    const numericVars: Record<string, number> = {};
    for (const [key, val] of Object.entries(tagValues)) {
      const num = Number(val);
      if (!Number.isNaN(num)) {
        numericVars[key] = num;
      }
    }
    // Support NaN as a named constant so substituted 'NaN' tokens resolve
    numericVars['NaN'] = NaN;

    const result = safeEvaluateExpression(substituted, numericVars);

    if (Number.isNaN(result)) {
      return { value: 'NaN' };
    }
    return { value: Number.isInteger(result) ? String(result) : result.toFixed(4) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Evaluation failed';
    return { value: '?', error: message };
  }
}

/* ------------------------------------------------------------------ */
/*  Autocomplete helpers                                                */
/* ------------------------------------------------------------------ */

/**
 * Detect if the cursor is inside a tag reference being typed.
 * Returns the partial tag name typed so far, or null if not in a reference.
 */
export function getTagAutocompleteContext(
  text: string,
  cursorPos: number,
): string | null {
  // Walk backwards from cursor to find "${"
  const before = text.slice(0, cursorPos);
  const lastOpen = before.lastIndexOf('${');
  if (lastOpen === -1) return null;

  // Check there's no closing brace between the ${ and cursor
  const segment = before.slice(lastOpen + 2);
  if (segment.includes('}')) return null;

  return segment;
}
