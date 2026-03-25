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

/**
 * Attempt to evaluate an expression with the given tag values.
 * Uses a simple substitution approach until the Phase 4A evaluator
 * is available, at which point this delegates to the real engine.
 */
export function tryEvaluate(
  expr: string,
  tagValues: Record<string, number | string | boolean>,
): EvaluationResult {
  try {
    // Replace tag references with their values
    let substituted = expr.replace(TAG_REF_RE, (_, tagName: string) => {
      const val = tagValues[tagName];
      if (val === undefined) return 'NaN';
      return String(val);
    });

    // Sanitize: only allow numbers, operators, parentheses, basic math funcs
    const safePattern = /^[\d\s+\-*/%().,:?<>=!&|a-zA-Z_]+$/;
    if (!safePattern.test(substituted)) {
      return { value: '?', error: 'Contains invalid characters' };
    }

    // Replace common function names with Math equivalents for eval
    substituted = substituted
      .replace(/\babs\(/g, 'Math.abs(')
      .replace(/\bsqrt\(/g, 'Math.sqrt(')
      .replace(/\bpow\(/g, 'Math.pow(')
      .replace(/\bround\(/g, 'Math.round(')
      .replace(/\bfloor\(/g, 'Math.floor(')
      .replace(/\bceil\(/g, 'Math.ceil(')
      .replace(/\blog\(/g, 'Math.log(')
      .replace(/\bexp\(/g, 'Math.exp(')
      .replace(/\bmin\(/g, 'Math.min(')
      .replace(/\bmax\(/g, 'Math.max(');

    // clamp(val, min, max) -> Math.min(Math.max(val, min), max)
    substituted = substituted.replace(
      /\bclamp\(([^,]+),([^,]+),([^)]+)\)/g,
      'Math.min(Math.max($1,$2),$3)',
    );

    // eslint-disable-next-line no-new-func -- sandbox expression evaluation for preview only
    const result = new Function(`"use strict"; return (${substituted});`)();
    const numResult = Number(result);
    if (Number.isNaN(numResult)) {
      return { value: String(result) };
    }
    // Format to reasonable precision
    return { value: Number.isInteger(numResult) ? String(numResult) : numResult.toFixed(4) };
  } catch {
    return { value: '?', error: 'Evaluation failed' };
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
