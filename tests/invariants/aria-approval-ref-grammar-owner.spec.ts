/**
 * ARIA-HIGH-238 — an operator approval reference has ONE grammar owner: the
 * kernel (`operator_approval.parse_github_approval_ref`, reached from a
 * workflow through `aria-kernel operator check-ref`).
 *
 * WHY. Before this, two workflows each validated an operator-supplied approval
 * ref with their own hand-written regex, and the two disagreed:
 *
 *   - aria-agent-executor.yml accepted `^[A-Za-z0-9/_.:#-]{1,128}$` for the
 *     breaker-quarantine ref — any free string, the grammar the kernel had
 *     already retired (ARIA-CRITICAL-216), so a dispatch passed the workflow's
 *     check and only the kernel could refuse it;
 *   - aria-auto-cycle.yml carried a `gh:...(comment|review)...` copy of the
 *     kernel's pattern, which drifts the day the kernel's grammar moves.
 *
 * A second copy of a grammar is how two answers to "is this an approval?"
 * start to differ. This spec makes the copy detectable (tier 3): every step
 * that receives an approval ref from a workflow input must run
 * `operator check-ref` on it before any other use, as a plain command whose
 * failure aborts the step, and no workflow or composite action may spell the
 * grammar (or pattern-match an approval ref in shell) itself.
 *
 * WHICH VARIABLES. The vocabulary is the kernel pin's own `APPROVAL_PARAMETER`
 * (aria-kernel/tests/test_operator_approval_callers.py), read from that file.
 * A second spelling here (`/APPROVAL_REF$/`) missed `operator_ref`, the
 * parameter `mcp release --operator-ref` takes.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

import yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');
const ACTIONS_DIR = join(REPO_ROOT, '.github', 'actions');
const KERNEL_PIN = join(REPO_ROOT, 'aria-kernel', 'tests', 'test_operator_approval_callers.py');

/** The approval-reference vocabulary, read from its one owner (the kernel pin). */
function kernelApprovalVocabulary(): RegExp {
  const match = /^APPROVAL_PARAMETER = re\.compile\(r"([^"]+)"\)$/m.exec(
    readFileSync(KERNEL_PIN, 'utf8'),
  );
  if (match === null || match[1] === undefined) {
    throw new Error(`${relative(REPO_ROOT, KERNEL_PIN)} no longer defines APPROVAL_PARAMETER`);
  }
  return new RegExp(match[1]);
}

const APPROVAL_PARAMETER_RE = kernelApprovalVocabulary();
/** A read of the workflow inputs context: the value is operator-supplied. */
const INPUTS_CONTEXT_RE = /(?<![A-Za-z0-9_.])(?:github\.event\.inputs|inputs)\s*(?:\.|\[)/;
/** A hand-written copy of the GitHub act grammar. */
const GH_GRAMMAR_RE = /gh:[^\n]*\(\s*comment\s*\|\s*review\s*\)/;

type Step = { name?: unknown; env?: unknown; run?: unknown };

interface StepRef {
  readonly file: string;
  readonly label: string;
  readonly env: Record<string, string>;
  readonly run: string;
}

function yamlFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...yamlFilesUnder(path));
    else if (/\.ya?ml$/.test(entry)) out.push(path);
  }
  return out.sort();
}

function stepsOf(document: unknown): Step[] {
  if (document === null || typeof document !== 'object') return [];
  const doc = document as {
    jobs?: Record<string, { steps?: unknown }>;
    runs?: { steps?: unknown };
  };
  const lists: unknown[] = [];
  for (const job of Object.values(doc.jobs ?? {})) lists.push(job?.steps);
  lists.push(doc.runs?.steps);
  return lists.flatMap((list) => (Array.isArray(list) ? (list as Step[]) : []));
}

function allSteps(): StepRef[] {
  const refs: StepRef[] = [];
  for (const path of [...yamlFilesUnder(WORKFLOWS_DIR), ...yamlFilesUnder(ACTIONS_DIR)]) {
    const document = yaml.load(readFileSync(path, 'utf8'));
    stepsOf(document).forEach((step, index) => {
      const env: Record<string, string> = {};
      if (step.env && typeof step.env === 'object') {
        for (const [key, value] of Object.entries(step.env as Record<string, unknown>))
          env[key] = String(value);
      }
      refs.push({
        file: relative(REPO_ROOT, path),
        label: typeof step.name === 'string' ? step.name : `step ${index}`,
        env,
        run: typeof step.run === 'string' ? step.run : '',
      });
    });
  }
  return refs;
}

const STEPS = allSteps();

/**
 * An env var carrying an approval reference: its name, or a `_`-bounded suffix
 * of it, is an approval parameter name in the kernel's vocabulary
 * (`QUARANTINE_APPROVAL_REF`, `OPERATOR_REF`, `MCP_OPERATOR_REF`).
 */
function isApprovalEnvName(name: string): boolean {
  const parts = name.toLowerCase().split('_');
  for (let index = 0; index < parts.length; index += 1) {
    if (APPROVAL_PARAMETER_RE.test(parts.slice(index).join('_'))) return true;
  }
  return false;
}

function operatorSuppliedApprovalVars(step: StepRef): string[] {
  return Object.entries(step.env)
    .filter(([key, value]) => isApprovalEnvName(key) && INPUTS_CONTEXT_RE.test(value))
    .map(([key]) => key);
}

/** `$VAR`, `${VAR}`, `${VAR:-}`, `${VAR#...}`: the start of any expansion of the variable. */
function expansion(variable: string): string {
  return `\\$\\{?${variable}(?![A-Za-z0-9_])`;
}

/** The step's shell lines, continuations joined and full-line comments dropped. */
function shellLines(run: string): string[] {
  return run
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line));
}

/** A command whose failure aborts a `set -e` step: env assignments, plain words, no operator. */
const PLAIN_CHECK_COMMAND_RE =
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s$`]*\s+)*[^\s$`()!]+(?:\s+[^\s$`()|&;]+)*\s+operator\s+check-ref\b[^|&;`]*$/;
const CONDITION_KEYWORD_RE = /^\s*(?:if|elif|while|until|!)\s/;
const ERREXIT_ON_RE = /^\s*set\s+(?:-[a-z]*e[a-z]*\b|-o\s+errexit\b)/;
const ERREXIT_OFF_RE = /^\s*set\s+(?:\+[a-z]*e[a-z]*\b|\+o\s+errexit\b)/;

/**
 * Every way `variable` escapes the kernel's check: never checked; used (other
 * than an emptiness test) before the check; checked by a command whose failure
 * does not abort the step (a condition, `||`, `&&`, a pipe, `;`, `&`, a
 * command substitution), or with no `set -e` in force.
 */
function kernelCheckViolations(run: string, variable: string): string[] {
  const lines = shellLines(run);
  const check = new RegExp(
    `\\boperator\\s+check-ref\\b[^\\n]*--ref\\s+"${expansion(variable)}\\}?"`,
  );
  const at = lines.findIndex((line) => check.test(line));
  // lines[-1] is undefined, so this one test covers "no check-ref line" and narrows the line.
  const checkLine = lines[at];
  if (checkLine === undefined) {
    return [`${variable} is not passed to \`operator check-ref --ref "$${variable}"\``];
  }
  const violations: string[] = [];
  const emptinessTest = new RegExp(`-[zn]\\s+"?${expansion(variable)}(?::-)?\\}?"?`, 'g');
  const anyUse = new RegExp(expansion(variable));
  if (lines.slice(0, at).some((line) => anyUse.test(line.replace(emptinessTest, '')))) {
    violations.push(`${variable} is used before \`operator check-ref\` checks it`);
  }
  if (CONDITION_KEYWORD_RE.test(checkLine) || !PLAIN_CHECK_COMMAND_RE.test(checkLine)) {
    violations.push(
      `\`operator check-ref\` on ${variable} is not a plain command whose failure aborts the step`,
    );
  }
  const errexit = lines.slice(0, at).reduce<boolean>((on, line) => {
    if (ERREXIT_ON_RE.test(line)) return true;
    if (ERREXIT_OFF_RE.test(line)) return false;
    return on;
  }, false);
  if (!errexit) {
    violations.push(`no \`set -e\` is in force where \`operator check-ref\` checks ${variable}`);
  }
  return violations;
}

/** Any shell pattern match on the variable: a second, hand-written grammar. */
function patternMatchesVariable(run: string, variable: string): boolean {
  const ref = `${expansion(variable)}[^\\s"]*\\}?"?`;
  return [
    new RegExp(`${ref}\\s*=~`),
    new RegExp(`\\[\\[\\s*"?${ref}\\s*(?:==?|!=)\\s`),
    new RegExp(`\\bcase\\s+"?${ref}\\s+in\\b`),
    new RegExp(`${ref}[^\\n]*\\|\\s*(?:e?grep|sed|awk)\\b`),
    new RegExp(`\\b(?:e?grep|sed|awk)\\b[^\\n]*<<<\\s*"?${expansion(variable)}`),
    new RegExp(`\\bexpr\\s+"?${ref}\\s+:`),
    new RegExp(`\\$\\{${variable}(?:##?|%%?|//?)`),
  ].some((pattern) => pattern.test(run));
}

describe('ARIA-HIGH-238 — one grammar owner for operator approval refs', () => {
  it('finds the operator-supplied approval refs it governs', () => {
    const governed = STEPS.filter((step) => operatorSuppliedApprovalVars(step).length > 0).map(
      (step) => `${step.file} :: ${step.label}`,
    );
    // Both lanes that take an approval ref from a dispatch input.
    expect(
      governed.some((label) => label.startsWith('.github/workflows/aria-agent-executor.yml')),
    ).toBe(true);
    expect(
      governed.some((label) => label.startsWith('.github/workflows/aria-auto-cycle.yml')),
    ).toBe(true);
  });

  it('every step that receives an approval ref from an input checks it first with `operator check-ref`', () => {
    const violations: string[] = [];
    for (const step of STEPS) {
      for (const variable of operatorSuppliedApprovalVars(step)) {
        for (const problem of kernelCheckViolations(step.run, variable)) {
          violations.push(`${step.file} :: ${step.label}: ${problem}`);
        }
        if (patternMatchesVariable(step.run, variable)) {
          violations.push(
            `${step.file} :: ${step.label}: ${variable} is pattern-matched in shell; the kernel owns the grammar`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('no workflow or composite action spells the GitHub act grammar itself', () => {
    const copies = STEPS.filter((step) => GH_GRAMMAR_RE.test(step.run)).map(
      (step) => `${step.file} :: ${step.label}`,
    );
    expect(copies).toEqual([]);
  });

  it("the governed vocabulary is the kernel pin's", () => {
    // The parameters the raising verbs take: `breaker reset` and `mcp release`.
    expect(APPROVAL_PARAMETER_RE.test('operator_approval_ref')).toBe(true);
    expect(APPROVAL_PARAMETER_RE.test('operator_ref')).toBe(true);
    for (const name of [
      'APPROVAL_REF',
      'QUARANTINE_APPROVAL_REF',
      'OPERATOR_REF',
      'MCP_OPERATOR_REF',
    ]) {
      expect({ name, governed: isApprovalEnvName(name) }).toEqual({ name, governed: true });
    }
    for (const name of ['GH_TOKEN', 'GITHUB_REF', 'TOOL_IDS', 'OPERATOR_REFS']) {
      expect({ name, governed: isApprovalEnvName(name) }).toEqual({ name, governed: false });
    }
    // The shape the panel named: an `mcp release` dispatch with the old free-string regex.
    const release: StepRef = {
      file: 'synthetic.yml',
      label: 'mcp release',
      env: { OPERATOR_REF: '${{ inputs.operator_ref }}' },
      run: 'set -euo pipefail\n[[ "$OPERATOR_REF" =~ ^[A-Za-z0-9/_.:#-]{1,128}$ ]]\n',
    };
    expect(operatorSuppliedApprovalVars(release)).toEqual(['OPERATOR_REF']);
    expect(patternMatchesVariable(release.run, 'OPERATOR_REF')).toBe(true);
    expect(kernelCheckViolations(release.run, 'OPERATOR_REF')).toHaveLength(1);
  });

  it('the detectors see the shapes they forbid', () => {
    const handWritten = [
      `GH_REF='gh:[A-Za-z0-9-]+/[A-Za-z0-9._-]+#[0-9]+/(comment|review)/[0-9]+'`,
      `if ! printf '%s' "\${APPROVAL_REF}" | grep -Eq "^\${GH_REF}$"; then exit 1; fi`,
    ].join('\n');
    expect(GH_GRAMMAR_RE.test(handWritten)).toBe(true);
    for (const [run, variable] of [
      [handWritten, 'APPROVAL_REF'],
      ['if ! [[ "$QUARANTINE_APPROVAL_REF" =~ ^[A-Za-z0-9]+$ ]]; then', 'QUARANTINE_APPROVAL_REF'],
      ['case "$OPERATOR_REF" in gh:*/comment/*) ;; *) exit 1 ;; esac', 'OPERATOR_REF'],
      ['[[ $OPERATOR_REF == gh:* ]] || exit 1', 'OPERATOR_REF'],
      ['grep -Eq "^gh:" <<< "$OPERATOR_REF"', 'OPERATOR_REF'],
      ['[ -n "${OPERATOR_REF#gh:}" ]', 'OPERATOR_REF'],
    ] as const) {
      expect({ run, matched: patternMatchesVariable(run, variable) }).toEqual({
        run,
        matched: true,
      });
    }
    expect(
      patternMatchesVariable('IFS=\',\' read -ra REFS <<< "${APPROVAL_REF}"', 'APPROVAL_REF'),
    ).toBe(false);

    const kernel = 'PYTHONPATH=aria-kernel python3 -m aria_kernel operator check-ref';
    const clean = [
      [
        'set -euo pipefail',
        '[ -n "${APPROVAL_REF}" ] || exit 1',
        `${kernel} \\`,
        '  --list \\',
        '  --ref "${APPROVAL_REF}"',
        'use "${APPROVAL_REF}"',
      ].join('\n'),
      [
        'set -e',
        'if [ -z "${APPROVAL_REF:-}" ]; then exit 1; fi',
        `${kernel} --ref "$APPROVAL_REF"`,
      ].join('\n'),
    ];
    for (const run of clean) {
      expect({ run, problems: kernelCheckViolations(run, 'APPROVAL_REF') }).toEqual({
        run,
        problems: [],
      });
    }
    for (const [run, expected] of [
      [['set -e', `${kernel} --ref "$OTHER"`].join('\n'), 'is not passed to'],
      [
        ['set -e', 'echo "$APPROVAL_REF"', `${kernel} --ref "$APPROVAL_REF"`].join('\n'),
        'is used before',
      ],
      [['set -e', `${kernel} --ref "$APPROVAL_REF" || true`].join('\n'), 'not a plain command'],
      [['set -e', `${kernel} --ref "$APPROVAL_REF" && echo ok`].join('\n'), 'not a plain command'],
      [
        ['set -e', `if ! ${kernel} --ref "$APPROVAL_REF"; then echo bad; fi`].join('\n'),
        'not a plain command',
      ],
      [['set -e', `echo "$(${kernel} --ref "$APPROVAL_REF")"`].join('\n'), 'not a plain command'],
      [`${kernel} --ref "$APPROVAL_REF"`, 'no `set -e`'],
      [
        ['set -euo pipefail', 'set +e', `${kernel} --ref "$APPROVAL_REF"`].join('\n'),
        'no `set -e`',
      ],
    ] as const) {
      expect({ run, problems: kernelCheckViolations(run, 'APPROVAL_REF').join('; ') }).toEqual({
        run,
        problems: expect.stringContaining(expected),
      });
    }
  });
});
