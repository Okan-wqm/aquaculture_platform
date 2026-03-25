/**
 * SCADA Expression Engine — barrel export.
 *
 * This module provides a safe, sandboxed expression language for
 * computed SCADA tags. Expressions can reference live tag values,
 * perform arithmetic and logical operations, and call a fixed set
 * of built-in math/interpolation functions.
 *
 * Security: No eval(), no Function(), no dynamic code execution.
 * The entire pipeline is: tokenize -> parse -> evaluate (AST walk).
 */

// Tokenizer
export { tokenize, type Token, type TokenType } from './tokenizer';

// Parser
export {
  parse,
  extractDependencies,
  type ASTNode,
  type NumberNode,
  type TagRefNode,
  type IdentifierNode,
  type BinaryNode,
  type UnaryNode,
  type CallNode,
  type TernaryNode,
  type ParseResult,
} from './parser';

// Evaluator
export {
  evaluate,
  type ExpressionValue,
  type EvaluationContext,
  type EvaluationResult,
} from './evaluator';

// React hook
export { useComputedExpression } from './useComputedExpression';

// Dependency graph
export {
  detectCycles,
  type ExpressionDefinition,
  type CycleDetectionResult,
} from './dependencyGraph';
