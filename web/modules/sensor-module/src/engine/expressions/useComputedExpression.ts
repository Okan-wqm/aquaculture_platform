/**
 * React hook that parses an expression, subscribes to its tag dependencies
 * via TagValueBus, and returns the computed value reactively.
 *
 * Architecture: The expression is parsed once (memoized on expression string).
 * Dependencies are extracted from the AST. The hook subscribes to only
 * the required tags — not all tags. When any dependency updates, the
 * expression is re-evaluated.
 *
 * Performance: For 500+ computed tags per screen, each evaluation is O(n)
 * where n is AST node count (typically < 20). No parsing on each update.
 * The useMemo on parse() means the AST is only rebuilt when the expression
 * string changes — which typically happens only on config edits, not on
 * live data updates.
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import type { TagValueBus } from '../tags/TagValueBus';
import { parse, type ASTNode } from './parser';
import { evaluate, type ExpressionValue } from './evaluator';

interface ComputedExpressionResult {
  value: ExpressionValue | null;
  error: string | null;
  dependencies: string[];
}

/**
 * Parse, subscribe, evaluate — the reactive expression pipeline.
 *
 * @param expression - The expression string (e.g., "${temp} * 1.8 + 32")
 * @param tagBus - The TagValueBus instance to subscribe to (null = disabled)
 * @returns Computed value, error string, and resolved dependency list
 */
export function useComputedExpression(
  expression: string,
  tagBus: TagValueBus | null,
): ComputedExpressionResult {
  // Parse the expression once per expression string change.
  // This is the "compile" phase — cheap to memoize.
  const parseResult = useMemo(() => {
    if (!expression || expression.trim().length === 0) {
      return { ast: null as ASTNode | null, error: null as string | null, dependencies: [] as string[] };
    }
    return parse(expression);
  }, [expression]);

  const [value, setValue] = useState<ExpressionValue | null>(null);
  const [error, setError] = useState<string | null>(parseResult.error);

  // Use a ref to keep the latest AST available in the subscription callback
  // without causing re-subscriptions when only the AST reference changes.
  const astRef = useRef<ASTNode | null>(parseResult.ast);
  astRef.current = parseResult.ast;

  // Sync parse errors to state
  useEffect(() => {
    setError(parseResult.error);
    if (parseResult.error) {
      setValue(null);
    }
  }, [parseResult.error]);

  // Subscribe to tag dependencies and re-evaluate on changes
  useEffect(() => {
    if (!tagBus || !parseResult.ast || parseResult.error) return;

    const { dependencies } = parseResult;
    if (dependencies.length === 0) {
      // Pure constant expression with no tag dependencies — evaluate once
      const result = evaluate(parseResult.ast, { tagValues: {} });
      setValue(result.value);
      setError(result.error);
      return;
    }

    // Build initial tag values snapshot and evaluate immediately
    const evaluateNow = () => {
      const currentAst = astRef.current;
      if (!currentAst) return;

      const tagValues: Record<string, ExpressionValue> = {};
      for (const dep of dependencies) {
        const raw = tagBus.getLatest(dep);
        if (raw !== undefined) {
          tagValues[dep] = raw as ExpressionValue;
        }
      }

      const result = evaluate(currentAst, { tagValues });
      setValue(result.value);
      setError(result.error);
    };

    // Initial evaluation with current values
    evaluateNow();

    // Subscribe to each dependency tag.
    // When any dependency changes, re-evaluate the full expression.
    const unsubscribes = dependencies.map((tagName) =>
      tagBus.subscribe(tagName, () => evaluateNow()),
    );

    return () => {
      unsubscribes.forEach((unsub) => unsub());
    };
  }, [tagBus, parseResult.ast, parseResult.error, parseResult.dependencies]);

  return {
    value,
    error,
    dependencies: parseResult.dependencies,
  };
}
