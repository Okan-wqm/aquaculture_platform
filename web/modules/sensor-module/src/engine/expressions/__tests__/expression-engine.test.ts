/**
 * Comprehensive test suite for the SCADA Expression Engine.
 *
 * Tests cover:
 * - Tokenizer: lexical analysis correctness and error handling
 * - Parser: operator precedence, AST structure, dependency extraction
 * - Evaluator: arithmetic, comparison, logic, built-in functions, safety
 * - Dependency graph: cycle detection, topological ordering, diamond deps
 */

import { describe, it, expect } from 'vitest';
import { tokenize, type Token } from '../tokenizer';
import { parse, type ASTNode } from '../parser';
import { evaluate, type EvaluationContext } from '../evaluator';
import { detectCycles, type ExpressionDefinition } from '../dependencyGraph';

// =============================================================================
// TOKENIZER TESTS
// =============================================================================

describe('Tokenizer', () => {
  it('should tokenize integer and float numbers', () => {
    const tokens = tokenize('42 3.14 .5');
    const values = tokens.filter((t) => t.type === 'number').map((t) => t.value);
    expect(values).toEqual(['42', '3.14', '.5']);
  });

  it('should tokenize identifiers', () => {
    const tokens = tokenize('temperature sensor.flow_rate');
    const ids = tokens.filter((t) => t.type === 'identifier').map((t) => t.value);
    expect(ids).toEqual(['temperature', 'sensor.flow_rate']);
  });

  it('should tokenize all operators', () => {
    const tokens = tokenize('+ - * / % ** == != < > <= >= && || !');
    const ops = tokens.filter((t) => t.type === 'operator').map((t) => t.value);
    expect(ops).toEqual(['+', '-', '*', '/', '%', '**', '==', '!=', '<', '>', '<=', '>=', '&&', '||', '!']);
  });

  it('should tokenize tag references with ${} syntax', () => {
    const tokens = tokenize('${temperature} + ${sensor.ph}');
    const refs = tokens.filter((t) => t.type === 'tagRef').map((t) => t.value);
    expect(refs).toEqual(['temperature', 'sensor.ph']);
  });

  it('should tokenize grouping, comma, question, and colon', () => {
    const tokens = tokenize('( ) , ? :');
    const types = tokens.filter((t) => t.type !== 'eof').map((t) => t.type);
    expect(types).toEqual(['leftParen', 'rightParen', 'comma', 'question', 'colon']);
  });

  it('should produce error token on unknown characters', () => {
    const tokens = tokenize('x + @');
    const errorToken = tokens.find((t) => t.type === 'error');
    expect(errorToken).toBeDefined();
    expect(errorToken!.value).toContain('@');
  });

  it('should produce error on unterminated tag reference', () => {
    const tokens = tokenize('${unclosed');
    const errorToken = tokens.find((t) => t.type === 'error');
    expect(errorToken).toBeDefined();
    expect(errorToken!.value).toContain('Unterminated');
  });

  it('should produce error on empty tag reference', () => {
    const tokens = tokenize('${}');
    const errorToken = tokens.find((t) => t.type === 'error');
    expect(errorToken).toBeDefined();
    expect(errorToken!.value).toContain('Empty');
  });

  it('should track token positions correctly', () => {
    const tokens = tokenize('a + b');
    expect(tokens[0].position).toBe(0);
    expect(tokens[1].position).toBe(2);
    expect(tokens[2].position).toBe(4);
  });

  it('should always end with an eof token', () => {
    const tokens = tokenize('1 + 2');
    expect(tokens[tokens.length - 1].type).toBe('eof');
  });

  it('should handle two-char operators adjacent to operands', () => {
    const tokens = tokenize('x**2');
    const types = tokens.filter((t) => t.type !== 'eof').map((t) => t.type);
    expect(types).toEqual(['identifier', 'operator', 'number']);
    expect(tokens[1].value).toBe('**');
  });
});

// =============================================================================
// PARSER TESTS
// =============================================================================

describe('Parser', () => {
  it('should parse simple arithmetic respecting precedence (1 + 2 * 3 = 7)', () => {
    const result = parse('1 + 2 * 3');
    expect(result.error).toBeNull();
    expect(result.ast).not.toBeNull();

    // The AST should be: (1) + (2 * 3), not (1 + 2) * 3
    const ast = result.ast!;
    expect(ast.type).toBe('binary');
    if (ast.type === 'binary') {
      expect(ast.operator).toBe('+');
      expect(ast.left).toEqual({ type: 'number', value: 1 });
      expect(ast.right.type).toBe('binary');
      if (ast.right.type === 'binary') {
        expect(ast.right.operator).toBe('*');
      }
    }
  });

  it('should parse nested parentheses', () => {
    const result = parse('(1 + 2) * (3 + 4)');
    expect(result.error).toBeNull();
    expect(result.ast).not.toBeNull();

    const ast = result.ast!;
    expect(ast.type).toBe('binary');
    if (ast.type === 'binary') {
      expect(ast.operator).toBe('*');
      // Both sides should be binary additions
      expect(ast.left.type).toBe('binary');
      expect(ast.right.type).toBe('binary');
    }
  });

  it('should parse function calls', () => {
    const result = parse('abs(-5)');
    expect(result.error).toBeNull();
    expect(result.ast).not.toBeNull();

    const ast = result.ast!;
    expect(ast.type).toBe('call');
    if (ast.type === 'call') {
      expect(ast.name).toBe('abs');
      expect(ast.args).toHaveLength(1);
      // Argument should be a unary negation of 5
      expect(ast.args[0].type).toBe('unary');
    }
  });

  it('should parse multi-argument function calls', () => {
    const result = parse('clamp(x, 0, 100)');
    expect(result.error).toBeNull();

    const ast = result.ast!;
    expect(ast.type).toBe('call');
    if (ast.type === 'call') {
      expect(ast.name).toBe('clamp');
      expect(ast.args).toHaveLength(3);
    }
  });

  it('should parse ternary expressions', () => {
    const result = parse('x > 0 ? x : -x');
    expect(result.error).toBeNull();

    const ast = result.ast!;
    expect(ast.type).toBe('ternary');
    if (ast.type === 'ternary') {
      expect(ast.condition.type).toBe('binary');
      expect(ast.consequent.type).toBe('identifier');
      expect(ast.alternate.type).toBe('unary');
    }
  });

  it('should parse tag references with ${} syntax', () => {
    const result = parse('${temperature} * 1.8 + 32');
    expect(result.error).toBeNull();

    const ast = result.ast!;
    expect(ast.type).toBe('binary');
    // The ${temperature} should become a tagRef node
    if (ast.type === 'binary' && ast.left.type === 'binary') {
      expect(ast.left.left.type).toBe('tagRef');
      if (ast.left.left.type === 'tagRef') {
        expect(ast.left.left.name).toBe('temperature');
      }
    }
  });

  it('should extract dependencies from AST', () => {
    const result = parse('${temperature} + ${pressure} * flow');
    expect(result.error).toBeNull();
    expect(result.dependencies).toContain('temperature');
    expect(result.dependencies).toContain('pressure');
    expect(result.dependencies).toContain('flow');
  });

  it('should not include function names in dependencies', () => {
    const result = parse('abs(${temperature}) + max(flow, 0)');
    expect(result.error).toBeNull();
    expect(result.dependencies).toContain('temperature');
    expect(result.dependencies).toContain('flow');
    expect(result.dependencies).not.toContain('abs');
    expect(result.dependencies).not.toContain('max');
  });

  it('should report syntax errors with position info', () => {
    const result = parse('1 + + 2');
    expect(result.error).not.toBeNull();
    expect(result.error).toContain('position');
  });

  it('should report error for empty expression', () => {
    const result = parse('');
    expect(result.error).toBe('Empty expression');
    expect(result.ast).toBeNull();
  });

  it('should report error for unclosed parenthesis', () => {
    const result = parse('(1 + 2');
    expect(result.error).not.toBeNull();
  });

  it('should parse power operator as right-associative', () => {
    // 2 ** 3 ** 2 should be 2 ** (3 ** 2) = 2 ** 9 = 512
    const result = parse('2 ** 3 ** 2');
    expect(result.error).toBeNull();

    const ast = result.ast!;
    expect(ast.type).toBe('binary');
    if (ast.type === 'binary') {
      expect(ast.operator).toBe('**');
      expect(ast.left).toEqual({ type: 'number', value: 2 });
      // Right side should also be a power expression
      expect(ast.right.type).toBe('binary');
      if (ast.right.type === 'binary') {
        expect(ast.right.operator).toBe('**');
      }
    }
  });

  it('should parse logical operators with correct precedence', () => {
    // a && b || c should be (a && b) || c
    const result = parse('a && b || c');
    expect(result.error).toBeNull();

    const ast = result.ast!;
    expect(ast.type).toBe('binary');
    if (ast.type === 'binary') {
      expect(ast.operator).toBe('||');
      expect(ast.left.type).toBe('binary');
      if (ast.left.type === 'binary') {
        expect(ast.left.operator).toBe('&&');
      }
    }
  });
});

// =============================================================================
// EVALUATOR TESTS
// =============================================================================

describe('Evaluator', () => {
  const emptyCtx: EvaluationContext = { tagValues: {} };

  function evalExpr(expr: string, tagValues: Record<string, number | boolean | string> = {}) {
    const { ast, error: parseError } = parse(expr);
    if (parseError || !ast) throw new Error(`Parse error: ${parseError}`);
    return evaluate(ast, { tagValues });
  }

  it('should evaluate arithmetic operators (+, -, *, /, %, **)', () => {
    expect(evalExpr('2 + 3').value).toBe(5);
    expect(evalExpr('10 - 4').value).toBe(6);
    expect(evalExpr('3 * 7').value).toBe(21);
    expect(evalExpr('15 / 3').value).toBe(5);
    expect(evalExpr('17 % 5').value).toBe(2);
    expect(evalExpr('2 ** 10').value).toBe(1024);
  });

  it('should respect operator precedence', () => {
    expect(evalExpr('1 + 2 * 3').value).toBe(7);
    expect(evalExpr('(1 + 2) * 3').value).toBe(9);
    expect(evalExpr('2 + 3 ** 2').value).toBe(11);
  });

  it('should evaluate comparison operators', () => {
    expect(evalExpr('5 > 3').value).toBe(1);
    expect(evalExpr('3 > 5').value).toBe(0);
    expect(evalExpr('5 < 3').value).toBe(0);
    expect(evalExpr('3 < 5').value).toBe(1);
    expect(evalExpr('5 >= 5').value).toBe(1);
    expect(evalExpr('5 <= 5').value).toBe(1);
    expect(evalExpr('5 == 5').value).toBe(1);
    expect(evalExpr('5 != 3').value).toBe(1);
  });

  it('should evaluate logical operators (&& ||)', () => {
    expect(evalExpr('1 && 1').value).toBe(1);
    expect(evalExpr('1 && 0').value).toBe(0);
    expect(evalExpr('0 || 1').value).toBe(1);
    expect(evalExpr('0 || 0').value).toBe(0);
  });

  it('should evaluate unary operators (- and !)', () => {
    expect(evalExpr('-5').value).toBe(-5);
    expect(evalExpr('!0').value).toBe(1);
    expect(evalExpr('!1').value).toBe(0);
    expect(evalExpr('!5').value).toBe(0);
  });

  it('should evaluate built-in math functions', () => {
    expect(evalExpr('abs(-5)').value).toBe(5);
    expect(evalExpr('abs(5)').value).toBe(5);
    expect(evalExpr('min(3, 7)').value).toBe(3);
    expect(evalExpr('max(3, 7)').value).toBe(7);
    expect(evalExpr('sqrt(16)').value).toBe(4);
    expect(evalExpr('pow(2, 8)').value).toBe(256);
    expect(evalExpr('round(3.7)').value).toBe(4);
    expect(evalExpr('floor(3.9)').value).toBe(3);
    expect(evalExpr('ceil(3.1)').value).toBe(4);
  });

  it('should evaluate interpolation functions (clamp, lerp, map)', () => {
    expect(evalExpr('clamp(5, 0, 10)').value).toBe(5);
    expect(evalExpr('clamp(-5, 0, 10)').value).toBe(0);
    expect(evalExpr('clamp(15, 0, 10)').value).toBe(10);

    expect(evalExpr('lerp(0, 100, 0.5)').value).toBe(50);
    expect(evalExpr('lerp(0, 100, 0)').value).toBe(0);
    expect(evalExpr('lerp(0, 100, 1)').value).toBe(100);

    expect(evalExpr('map(50, 0, 100, 0, 1)').value).toBe(0.5);
    expect(evalExpr('map(0, 0, 100, 10, 20)').value).toBe(10);
    expect(evalExpr('map(100, 0, 100, 10, 20)').value).toBe(20);
  });

  it('should evaluate ternary expressions', () => {
    expect(evalExpr('1 > 0 ? 42 : 0').value).toBe(42);
    expect(evalExpr('0 > 1 ? 42 : 99').value).toBe(99);
  });

  it('should evaluate if() function', () => {
    expect(evalExpr('if(1, 42, 0)').value).toBe(42);
    expect(evalExpr('if(0, 42, 99)').value).toBe(99);
  });

  it('should resolve tag values from context', () => {
    const result = evalExpr('${temperature} * 1.8 + 32', { temperature: 100 });
    expect(result.value).toBe(212); // 100 * 1.8 + 32 = 212 (Fahrenheit)
    expect(result.error).toBeNull();
  });

  it('should resolve bare identifiers as tag references', () => {
    const result = evalExpr('temperature * 1.8 + 32', { temperature: 0 });
    expect(result.value).toBe(32); // 0 * 1.8 + 32 = 32
  });

  it('should return 0 for missing tags with no error', () => {
    const result = evalExpr('${missing_tag} + 5');
    expect(result.value).toBe(5);
    expect(result.error).toBeNull();
  });

  it('should return Infinity for division by zero', () => {
    const result = evalExpr('10 / 0');
    expect(result.value).toBe(Infinity);
    expect(result.error).toBeNull();
  });

  it('should return NaN for modulo by zero', () => {
    const result = evalExpr('10 % 0');
    expect(Number.isNaN(result.value)).toBe(true);
  });

  it('should evaluate conversion functions (bool, deg2rad, rad2deg)', () => {
    expect(evalExpr('bool(5)').value).toBe(1);
    expect(evalExpr('bool(0)').value).toBe(0);

    const deg2radResult = evalExpr('deg2rad(180)');
    expect(deg2radResult.value).toBeCloseTo(Math.PI, 10);

    const rad2degResult = evalExpr('rad2deg(3.14159265358979)');
    expect(rad2degResult.value).toBeCloseTo(180, 5);
  });

  it('should return error for unknown functions', () => {
    const result = evalExpr('unknown_func(1, 2)');
    expect(result.error).not.toBeNull();
    expect(result.error).toContain('Unknown function');
  });

  it('should handle nested function calls', () => {
    const result = evalExpr('abs(min(-5, -10))');
    expect(result.value).toBe(10);
  });

  it('should handle complex real-world expression', () => {
    // Dissolved oxygen saturation percentage calculation (simplified)
    const result = evalExpr(
      'clamp(${do_mg_l} / ${do_saturation} * 100, 0, 200)',
      { do_mg_l: 8.5, do_saturation: 10 },
    );
    expect(result.value).toBe(85);
  });
});

// =============================================================================
// DEPENDENCY GRAPH TESTS
// =============================================================================

describe('Dependency Graph', () => {
  it('should detect a simple cycle (A -> B -> A)', () => {
    const expressions: ExpressionDefinition[] = [
      { name: 'A', expression: '${B} + 1', dependencies: ['B'] },
      { name: 'B', expression: '${A} * 2', dependencies: ['A'] },
    ];

    const result = detectCycles(expressions);
    expect(result.order).toBeNull();
    expect(result.cycle).not.toBeNull();
    expect(result.cycle!.length).toBeGreaterThanOrEqual(2);
    // The cycle should contain both A and B
    expect(result.cycle!).toContain('A');
    expect(result.cycle!).toContain('B');
  });

  it('should return correct topological order for acyclic graph', () => {
    // C depends on B, B depends on A
    const expressions: ExpressionDefinition[] = [
      { name: 'C', expression: '${B} + 1', dependencies: ['B'] },
      { name: 'A', expression: '${sensor} * 2', dependencies: ['sensor'] },
      { name: 'B', expression: '${A} + 10', dependencies: ['A'] },
    ];

    const result = detectCycles(expressions);
    expect(result.cycle).toBeNull();
    expect(result.order).not.toBeNull();

    const order = result.order!;
    expect(order).toHaveLength(3);

    // A must come before B, B must come before C
    const indexA = order.indexOf('A');
    const indexB = order.indexOf('B');
    const indexC = order.indexOf('C');
    expect(indexA).toBeLessThan(indexB);
    expect(indexB).toBeLessThan(indexC);
  });

  it('should handle diamond dependencies without false cycle detection', () => {
    // Diamond: D depends on B and C, both B and C depend on A
    //      A
    //     / \
    //    B   C
    //     \ /
    //      D
    const expressions: ExpressionDefinition[] = [
      { name: 'A', expression: '${sensor} + 1', dependencies: ['sensor'] },
      { name: 'B', expression: '${A} * 2', dependencies: ['A'] },
      { name: 'C', expression: '${A} * 3', dependencies: ['A'] },
      { name: 'D', expression: '${B} + ${C}', dependencies: ['B', 'C'] },
    ];

    const result = detectCycles(expressions);
    expect(result.cycle).toBeNull();
    expect(result.order).not.toBeNull();

    const order = result.order!;
    expect(order).toHaveLength(4);

    // A must come before B and C; B and C must come before D
    const indexA = order.indexOf('A');
    const indexB = order.indexOf('B');
    const indexC = order.indexOf('C');
    const indexD = order.indexOf('D');
    expect(indexA).toBeLessThan(indexB);
    expect(indexA).toBeLessThan(indexC);
    expect(indexB).toBeLessThan(indexD);
    expect(indexC).toBeLessThan(indexD);
  });

  it('should handle empty expression list', () => {
    const result = detectCycles([]);
    expect(result.order).toEqual([]);
    expect(result.cycle).toBeNull();
  });

  it('should handle expressions with no inter-dependencies', () => {
    const expressions: ExpressionDefinition[] = [
      { name: 'A', expression: '${sensor1} + 1', dependencies: ['sensor1'] },
      { name: 'B', expression: '${sensor2} * 2', dependencies: ['sensor2'] },
      { name: 'C', expression: '${sensor3} / 3', dependencies: ['sensor3'] },
    ];

    const result = detectCycles(expressions);
    expect(result.cycle).toBeNull();
    expect(result.order).not.toBeNull();
    expect(result.order!).toHaveLength(3);
  });

  it('should detect three-node cycle (A -> B -> C -> A)', () => {
    const expressions: ExpressionDefinition[] = [
      { name: 'A', expression: '${C} + 1', dependencies: ['C'] },
      { name: 'B', expression: '${A} * 2', dependencies: ['A'] },
      { name: 'C', expression: '${B} - 1', dependencies: ['B'] },
    ];

    const result = detectCycles(expressions);
    expect(result.order).toBeNull();
    expect(result.cycle).not.toBeNull();
    expect(result.cycle!.length).toBeGreaterThanOrEqual(3);
  });

  it('should ignore dependencies on non-computed tags (raw sensor tags)', () => {
    // A depends on "sensor" which is a raw tag (not in computed set)
    const expressions: ExpressionDefinition[] = [
      { name: 'A', expression: '${sensor} + 1', dependencies: ['sensor'] },
    ];

    const result = detectCycles(expressions);
    expect(result.cycle).toBeNull();
    expect(result.order).toEqual(['A']);
  });
});
