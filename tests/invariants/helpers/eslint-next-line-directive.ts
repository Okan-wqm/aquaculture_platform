/**
 * How an ESLint next-line directive binds: the one model shared by
 * no-direct-getrepository-call.spec.ts (walking back from a call to its
 * directive) and the SEC-REVIEW-003 positional-binding spec (walking forward
 * from a directive to its call).
 *
 * WHY. The directive covers the LITERAL next line, a comment or blank line
 * included. Both specs once modelled ESLint as skipping comment lines, so a
 * directive followed by a rationale comment passed both while ESLint still
 * reported the call it was written for (libs/backend-common tenantManagerRepo,
 * paid down on 2026-10-16). One spec was corrected first; the other kept the
 * old model. Two copies of the same semantics drift, so there is one.
 *
 * WHAT. ESLint reports a `getRepository` CallExpression at its `loc.start`,
 * the start of the outermost callee chain. For a fluent chain
 *
 *     // <next-line directive> no-restricted-syntax -- <rationale>
 *     const repo = await manager        <- statement start, covered line
 *       .getRepository(Entity)          <- continuation line
 *
 * the covered line is the statement start, found by walking back over
 * continuation lines; the directive must sit on the line directly above it.
 */

/** Built from parts so this file carries no directive of its own. */
export const NEXT_LINE_DIRECTIVE_TOKEN = ['eslint', 'disable', 'next', 'line'].join('-');

/** A `no-restricted-syntax` next-line directive; group 1 is the `-- <rationale>` text. */
export const NO_RESTRICTED_SYNTAX_DIRECTIVE_RE = new RegExp(
  `//\\s*${NEXT_LINE_DIRECTIVE_TOKEN}\\s+no-restricted-syntax(?:\\s*--\\s*(.+))?$`,
);

/** A blank line, a line comment, or a block-comment opener or continuation. */
export function isBlankOrCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed === '' ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*')
  );
}

/**
 * A physical line whose first token continues an expression begun on an
 * earlier line: property access, optional chaining, argument and bracket
 * spillover, binary, nullish and ternary operators. A statement that holds a
 * restricted call does not begin with one of these tokens; `}` and `/` also
 * match closing braces and comment lines inside a chain, which both callers
 * walk over on purpose.
 */
export function isContinuationLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  return ['.', '?.', ',', ')', ']', '}', '&&', '||', '??', '+', '-', '*', '/', '?', ':', '='].some(
    (token) => trimmed.startsWith(token),
  );
}

/** The index of the line the statement holding `index` starts on. */
export function statementStartIndex(lines: readonly string[], index: number): number {
  let start = index;
  while (start > 0 && isContinuationLine(lines[start] ?? '')) start -= 1;
  return start;
}

/** Whether a no-restricted-syntax next-line directive covers the line at `index`. */
export function isCoveredByNoRestrictedSyntaxDirective(
  lines: readonly string[],
  index: number,
): boolean {
  return index > 0 && NO_RESTRICTED_SYNTAX_DIRECTIVE_RE.test(lines[index - 1] ?? '');
}
