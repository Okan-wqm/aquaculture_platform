/**
 * Invariant: a finding-registry reader asks the one unresolved-state predicate.
 *
 * # WHY
 *
 * The registry's lifecycle is FINDING_STATES (tools/gates/finding-registry-chain.ts). Only
 * RESOLVED ends a finding's debt. STALE and BLOCKED are the daily sweep's judgements about a
 * finding that is still owed: it stales a row by age and blocks it once its deadline lapses.
 * `isUnresolvedFindingState` / `UNRESOLVED_FINDING_STATES` answer "is this finding still owed?"
 * in that one place.
 *
 * Every reader that kept its own list of "active" states broke the day the sweep moved one of
 * its rows. debt-plan-truth's list made the sweep PR fail the debt-plan gate (ARIA-HIGH-534).
 * After that fix, three invariant specs still kept a list of their own: ci-image-registry
 * (OPEN or IN-PROGRESS), claude-md-accuracy (OPEN, IN-PROGRESS or BLOCKED) and
 * three-store-invariants (OPEN, IN-PROGRESS or RESOLVED). Each read a STALE or BLOCKED row as
 * closed or as invalid, so the sweep PR (#1335) failed invariants-fast every day and no
 * lifecycle transition reached the registry. A fix per reader keeps losing to the next reader,
 * so this spec makes the private list detectable at its source.
 *
 * # WHAT
 *
 * No TypeScript or JavaScript under tests/ or tools/ spells a set of two or more finding-state
 * literals. Two shapes count:
 *
 *   - an array literal holding two or more distinct state literals, which also covers a
 *     `new Set([...])` and an inline `[...].includes(state)`;
 *   - a `||` or `&&` chain that compares one expression with two or more distinct state
 *     literals (`===`, `!==`, `==`, `!=`).
 *
 * A single comparison is not a list and passes: `state === 'RESOLVED'` and
 * `state !== 'RESOLVED'` are the legitimate RESOLVED checks. Type-level unions are not
 * scanned.
 *
 * SANCTIONED_SITES lists the sites that keep their literals. One is the vocabulary itself.
 * The others are state-machine transition rules that name the states a transition starts
 * from, which answers a different question from "is it still owed". Each sanctioned site
 * must still hold a list, so the allowlist cannot outlive its site.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import * as ts from 'typescript';

import { FINDING_STATES } from '../../tools/gates/finding-registry-chain';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCANNED_ROOTS = ['tests', 'tools'] as const;
const SOURCE_FILE = /\.(?:[cm]?[jt]s|tsx)$/;
const STATE_WORDS: ReadonlySet<string> = new Set(FINDING_STATES);

interface StateList {
  readonly file: string;
  readonly line: number;
  /** Nearest enclosing named function, method or variable; `<module>` at top level. */
  readonly site: string;
  readonly states: readonly string[];
}

interface SanctionedSite {
  readonly file: string;
  readonly site: string;
  readonly why: string;
}

const SANCTIONED_SITES: readonly SanctionedSite[] = [
  {
    file: 'tools/gates/finding-registry-chain.ts',
    site: 'FINDING_STATES',
    why: 'the vocabulary itself; UNRESOLVED_FINDING_STATES is derived from it',
  },
  {
    file: 'tools/gates/finding-registry.ts',
    site: 'planSweep',
    why:
      'staleness transition source: the sweep stales only rows that carry no judgement yet; ' +
      'a BLOCKED row already carries one and a STALE row is already stale',
  },
  {
    file: 'tools/gates/finding-registry-projection.ts',
    site: 'applyClosureRejection',
    why:
      'override-reopen transition source; tools/gates/finding-traceability.spec.ts pins its ' +
      'refusal from STALE',
  },
];

const EQUALITY_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

const LOGICAL_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
]);

function unwrap(node: ts.Node): ts.Node {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)) {
    current = current.expression;
  }
  return current;
}

function stateLiteral(node: ts.Node): string | undefined {
  const inner = unwrap(node);
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) {
    return STATE_WORDS.has(inner.text) ? inner.text : undefined;
  }
  return undefined;
}

/** `subject <op> 'STATE'` (either side), as the subject's source text and the state. */
function stateComparison(
  node: ts.Node,
  source: ts.SourceFile,
): { readonly subject: string; readonly state: string } | undefined {
  const inner = unwrap(node);
  if (!ts.isBinaryExpression(inner) || !EQUALITY_OPERATORS.has(inner.operatorToken.kind)) {
    return undefined;
  }
  const right = stateLiteral(inner.right);
  if (right !== undefined) return { subject: unwrap(inner.left).getText(source), state: right };
  const left = stateLiteral(inner.left);
  if (left !== undefined) return { subject: unwrap(inner.right).getText(source), state: left };
  return undefined;
}

function parentSkippingParens(node: ts.Node): ts.Node | undefined {
  let parent = node.parent;
  while (parent !== undefined && ts.isParenthesizedExpression(parent)) parent = parent.parent;
  return parent;
}

/** The operands of a whole `a || b || c` chain (or `&&`), one operator per chain. */
function chainOperands(chain: ts.BinaryExpression): ts.Node[] {
  const operator = chain.operatorToken.kind;
  const operands: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    const inner = unwrap(node);
    if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === operator) {
      visit(inner.left);
      visit(inner.right);
    } else {
      operands.push(inner);
    }
  };
  visit(chain);
  return operands;
}

function enclosingSite(node: ts.Node): string {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isVariableDeclaration(current)) &&
      current.name !== undefined &&
      ts.isIdentifier(current.name)
    ) {
      return current.name.text;
    }
  }
  return '<module>';
}

function distinct(states: readonly string[]): string[] {
  return [...new Set(states)].sort();
}

/** Every hand-written finding-state list in one source text. */
function findStateLists(file: string, text: string): StateList[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: StateList[] = [];
  const record = (node: ts.Node, states: readonly string[]): void => {
    found.push({
      file,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      site: enclosingSite(node),
      states,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isArrayLiteralExpression(node)) {
      const states = distinct(
        node.elements.map(stateLiteral).filter((s): s is string => s !== undefined),
      );
      if (states.length >= 2) record(node, states);
    }

    if (ts.isBinaryExpression(node) && LOGICAL_OPERATORS.has(node.operatorToken.kind)) {
      const parent = parentSkippingParens(node);
      const continuesParentChain =
        parent !== undefined &&
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === node.operatorToken.kind;
      if (!continuesParentChain) {
        const statesBySubject = new Map<string, string[]>();
        for (const operand of chainOperands(node)) {
          const comparison = stateComparison(operand, source);
          if (comparison === undefined) continue;
          const states = statesBySubject.get(comparison.subject) ?? [];
          states.push(comparison.state);
          statesBySubject.set(comparison.subject, states);
        }
        for (const states of statesBySubject.values()) {
          const unique = distinct(states);
          if (unique.length >= 2) record(node, unique);
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function scannedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', ...SCANNED_ROOTS], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((file) => SOURCE_FILE.test(file) && !file.endsWith('.d.ts'));
}

function isSanctioned(list: StateList): boolean {
  return SANCTIONED_SITES.some((entry) => entry.file === list.file && entry.site === list.site);
}

function describeList(list: StateList): string {
  return `${list.file}:${list.line} (${list.site}) compares against {${list.states.join(', ')}}`;
}

describe('INVARIANT: registry readers ask isUnresolvedFindingState, not a private state list', () => {
  const lists = scannedFiles().flatMap((file) =>
    findStateLists(file, readFileSync(join(REPO_ROOT, file), 'utf8')),
  );

  it('no code under tests/ or tools/ spells its own list of finding states', () => {
    const violations = lists.filter((list) => !isSanctioned(list)).map(describeList);
    if (violations.length > 0) {
      throw new Error(
        `${violations.length} hand-written finding-state list(s). Ask the registry SSOT instead: ` +
          'isUnresolvedFindingState(state) / UNRESOLVED_FINDING_STATES for "is it still owed", ' +
          'FINDING_STATES for the vocabulary (tools/gates/finding-registry-chain.ts).\n  ' +
          violations.join('\n  '),
      );
    }
  });

  it('every sanctioned site still holds a state list', () => {
    const stale = SANCTIONED_SITES.filter(
      (entry) => !lists.some((list) => list.file === entry.file && list.site === entry.site),
    ).map((entry) => `${entry.file} (${entry.site})`);
    expect(stale).toEqual([]);
  });

  it('detects each list shape and passes single comparisons and the predicate', () => {
    const shapes = (text: string): string[] =>
      findStateLists('fixture.ts', text).map((list) => `${list.site}:${list.states.join(' ')}`);

    expect(shapes("const a = (r) => r.state === 'OPEN' || r.state === 'IN-PROGRESS';")).toEqual([
      'a:IN-PROGRESS OPEN',
    ]);
    expect(
      shapes("function f(r) { return ok && (r.state === 'BLOCKED' || (r.state === 'OPEN')); }"),
    ).toEqual(['f:BLOCKED OPEN']);
    expect(
      shapes("if (e.state !== 'RESOLVED' && e.state !== 'OPEN' && e.state !== 'IN-PROGRESS') {}"),
    ).toEqual(['<module>:IN-PROGRESS OPEN RESOLVED']);
    expect(shapes("const s = new Set(['OPEN', 'STALE', 'other']);")).toEqual(['s:OPEN STALE']);
    expect(shapes("expect(['OPEN', 'RESOLVED'] as const).toContain(row.state);")).toEqual([
      '<module>:OPEN RESOLVED',
    ]);

    expect(shapes("const r = row.state === 'RESOLVED';")).toEqual([]);
    expect(shapes("const u = row.state !== 'RESOLVED' && row.kind === 'OPEN';")).toEqual([]);
    expect(shapes("expect(actions.map((a) => a.toState)).toEqual(['STALE']);")).toEqual([]);
    expect(shapes('const u = rows.filter((r) => isUnresolvedFindingState(r.state));')).toEqual([]);
  });
});
