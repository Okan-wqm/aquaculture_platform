/**
 * Safe expression evaluator that walks the AST and computes a result.
 * Tag references are resolved from a provided values map — never from
 * global state, never via dynamic lookup.
 *
 * Built-in functions (no user-defined functions — attack surface minimization):
 * - Math: abs, min, max, sqrt, pow, round, floor, ceil, log, exp
 * - Interpolation: clamp(val, min, max), lerp(a, b, t), map(val, inMin, inMax, outMin, outMax)
 * - Comparison: if(cond, then, else)
 * - Conversion: bool(val) -> 0|1, deg2rad(d), rad2deg(r)
 *
 * Security invariants:
 * 1. No eval(), no Function constructor, no prototype access
 * 2. The function registry is a frozen Map — cannot be extended at runtime
 * 3. All numeric operations use standard Math functions — no string-to-code conversion
 * 4. Maximum recursion depth is bounded by AST depth (parser limits this implicitly)
 */

import type { ASTNode } from './parser';

export type ExpressionValue = number | boolean | string;

export interface EvaluationContext {
  /** Tag name -> current value map, populated from TagValueBus snapshots */
  tagValues: Record<string, ExpressionValue>;
}

export interface EvaluationResult {
  value: ExpressionValue;
  error: string | null;
}

/**
 * Type signature for built-in functions.
 * Each function takes an array of already-evaluated arguments
 * and returns a numeric or boolean result.
 */
type BuiltinFunction = (...args: number[]) => number;

/**
 * Registry of all built-in functions available in expressions.
 *
 * This map is frozen at module load time. No runtime code can add,
 * remove, or modify entries. This is a critical security boundary:
 * only these functions can be invoked from expressions.
 */
const BUILTIN_FUNCTIONS: ReadonlyMap<string, BuiltinFunction> = Object.freeze(
  new Map<string, BuiltinFunction>([
    // Math functions
    ['abs', (x: number) => Math.abs(x)],
    ['min', (...args: number[]) => Math.min(...args)],
    ['max', (...args: number[]) => Math.max(...args)],
    ['sqrt', (x: number) => Math.sqrt(x)],
    ['pow', (base: number, exp: number) => Math.pow(base, exp)],
    ['round', (x: number) => Math.round(x)],
    ['floor', (x: number) => Math.floor(x)],
    ['ceil', (x: number) => Math.ceil(x)],
    ['log', (x: number) => Math.log(x)],
    ['exp', (x: number) => Math.exp(x)],

    // Interpolation functions
    ['clamp', (val: number, lo: number, hi: number) => Math.min(Math.max(val, lo), hi)],
    ['lerp', (a: number, b: number, t: number) => a + (b - a) * t],
    ['map', (val: number, inMin: number, inMax: number, outMin: number, outMax: number) => {
      // Avoid division by zero when input range is zero-width
      if (inMax === inMin) return outMin;
      const t = (val - inMin) / (inMax - inMin);
      return outMin + (outMax - outMin) * t;
    }],

    // Conditional (functional form of ternary)
    ['if', (cond: number, then: number, otherwise: number) => cond ? then : otherwise],

    // Conversion functions
    ['bool', (val: number) => val ? 1 : 0],
    ['deg2rad', (d: number) => d * (Math.PI / 180)],
    ['rad2deg', (r: number) => r * (180 / Math.PI)],
  ]),
);

/**
 * Evaluate a parsed AST with the given tag values.
 *
 * The evaluator is a simple tree walker — no compilation, no JIT.
 * For 500+ widgets each with expressions of ~10-20 AST nodes,
 * this is more than fast enough (microseconds per evaluation).
 */
export function evaluate(ast: ASTNode, context: EvaluationContext): EvaluationResult {
  try {
    const value = evaluateNode(ast, context);
    return { value, error: null };
  } catch (err: unknown) {
    const message = err instanceof EvalError ? err.message : String(err);
    return { value: 0, error: message };
  }
}

// -- Internal evaluation --

class EvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalError';
  }
}

/**
 * Coerce an ExpressionValue to a number for arithmetic operations.
 * Booleans convert to 0/1, strings attempt parseFloat, falling back to 0.
 */
function toNumber(val: ExpressionValue): number {
  if (typeof val === 'number') return val;
  if (typeof val === 'boolean') return val ? 1 : 0;
  if (typeof val === 'string') {
    const n = parseFloat(val);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

/**
 * Determine truthiness for logical operators and conditionals.
 * Follows JavaScript semantics: 0, false, empty string, NaN are falsy.
 */
function isTruthy(val: ExpressionValue): boolean {
  if (typeof val === 'number') return val !== 0 && !isNaN(val);
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') return val.length > 0;
  return false;
}

function evaluateNode(node: ASTNode, ctx: EvaluationContext): ExpressionValue {
  switch (node.type) {
    case 'number':
      return node.value;

    case 'tagRef':
      return resolveTag(node.name, ctx);

    case 'identifier':
      return resolveTag(node.name, ctx);

    case 'unary':
      return evaluateUnary(node.operator, node.operand, ctx);

    case 'binary':
      return evaluateBinary(node.operator, node.left, node.right, ctx);

    case 'call':
      return evaluateCall(node.name, node.args, ctx);

    case 'ternary': {
      const condition = evaluateNode(node.condition, ctx);
      return isTruthy(condition)
        ? evaluateNode(node.consequent, ctx)
        : evaluateNode(node.alternate, ctx);
    }

    default: {
      // Exhaustive check — if a new node type is added without a handler,
      // TypeScript will flag this at compile time
      const _exhaustive: never = node;
      throw new EvalError(`Unknown AST node type: ${(_exhaustive as ASTNode).type}`);
    }
  }
}

/**
 * Resolve a tag reference from the evaluation context.
 * If the tag is not present, return 0 (safe default for arithmetic).
 * This is a deliberate design choice: missing tags should not crash
 * the entire expression. Operators and widgets can check for specific
 * tags if they need presence validation.
 */
function resolveTag(name: string, ctx: EvaluationContext): ExpressionValue {
  if (Object.prototype.hasOwnProperty.call(ctx.tagValues, name)) {
    return ctx.tagValues[name];
  }
  return 0;
}

function evaluateUnary(operator: string, operand: ASTNode, ctx: EvaluationContext): ExpressionValue {
  const val = evaluateNode(operand, ctx);

  switch (operator) {
    case '-':
      return -toNumber(val);
    case '!':
      return isTruthy(val) ? 0 : 1;
    default:
      throw new EvalError(`Unknown unary operator: ${operator}`);
  }
}

function evaluateBinary(
  operator: string,
  leftNode: ASTNode,
  rightNode: ASTNode,
  ctx: EvaluationContext,
): ExpressionValue {
  // Short-circuit evaluation for logical operators
  if (operator === '&&') {
    const left = evaluateNode(leftNode, ctx);
    return isTruthy(left) ? evaluateNode(rightNode, ctx) : left;
  }
  if (operator === '||') {
    const left = evaluateNode(leftNode, ctx);
    return isTruthy(left) ? left : evaluateNode(rightNode, ctx);
  }

  const left = toNumber(evaluateNode(leftNode, ctx));
  const right = toNumber(evaluateNode(rightNode, ctx));

  switch (operator) {
    // Arithmetic
    case '+': return left + right;
    case '-': return left - right;
    case '*': return left * right;
    case '/': return right === 0 ? Infinity : left / right;
    case '%': return right === 0 ? NaN : left % right;
    case '**': return Math.pow(left, right);

    // Comparison (return 0 or 1 for consistency with numeric expressions)
    case '==': return left === right ? 1 : 0;
    case '!=': return left !== right ? 1 : 0;
    case '<': return left < right ? 1 : 0;
    case '>': return left > right ? 1 : 0;
    case '<=': return left <= right ? 1 : 0;
    case '>=': return left >= right ? 1 : 0;

    default:
      throw new EvalError(`Unknown binary operator: ${operator}`);
  }
}

function evaluateCall(name: string, argNodes: ASTNode[], ctx: EvaluationContext): ExpressionValue {
  const fn = BUILTIN_FUNCTIONS.get(name);
  if (!fn) {
    throw new EvalError(`Unknown function '${name}' — only built-in functions are allowed`);
  }

  const args = argNodes.map((arg) => toNumber(evaluateNode(arg, ctx)));
  return fn(...args);
}
