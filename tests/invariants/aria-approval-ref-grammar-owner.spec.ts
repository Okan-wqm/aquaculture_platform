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
 * `operator check-ref` on it, and no workflow or composite action may spell
 * the grammar (or a regex test of an approval ref) itself.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

import yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');
const ACTIONS_DIR = join(REPO_ROOT, '.github', 'actions');

/** An env var carrying an approval reference. */
const APPROVAL_ENV_RE = /APPROVAL_REF$/;
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

function operatorSuppliedApprovalVars(step: StepRef): string[] {
  return Object.entries(step.env)
    .filter(([key, value]) => APPROVAL_ENV_RE.test(key) && INPUTS_CONTEXT_RE.test(value))
    .map(([key]) => key);
}

function checksWithKernel(run: string, variable: string): boolean {
  const ref = new RegExp(`operator\\s+check-ref\\b[^\\n]*--ref\\s+"\\$\\{?${variable}\\}?"`);
  return ref.test(run.replace(/\\\n\s*/g, ' '));
}

function regexTestsVariable(run: string, variable: string): boolean {
  const bashMatch = new RegExp(`\\$\\{?${variable}\\}?"?\\s*=~`);
  const grepPipe = new RegExp(`\\$\\{?${variable}\\}?[^\\n]*\\|\\s*grep\\b`);
  return bashMatch.test(run) || grepPipe.test(run);
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

  it('every step that receives an approval ref from an input checks it with `operator check-ref`', () => {
    const violations: string[] = [];
    for (const step of STEPS) {
      for (const variable of operatorSuppliedApprovalVars(step)) {
        if (!checksWithKernel(step.run, variable)) {
          violations.push(
            `${step.file} :: ${step.label}: ${variable} is not passed to \`operator check-ref --ref "$${variable}"\``,
          );
        }
        if (regexTestsVariable(step.run, variable)) {
          violations.push(
            `${step.file} :: ${step.label}: ${variable} is regex-tested in shell; the kernel owns the grammar`,
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

  it('the detectors see the shapes they forbid', () => {
    const handWritten = [
      `GH_REF='gh:[A-Za-z0-9-]+/[A-Za-z0-9._-]+#[0-9]+/(comment|review)/[0-9]+'`,
      `if ! printf '%s' "\${APPROVAL_REF}" | grep -Eq "^\${GH_REF}$"; then exit 1; fi`,
    ].join('\n');
    expect(GH_GRAMMAR_RE.test(handWritten)).toBe(true);
    expect(regexTestsVariable(handWritten, 'APPROVAL_REF')).toBe(true);
    expect(
      regexTestsVariable(
        'if ! [[ "$QUARANTINE_APPROVAL_REF" =~ ^[A-Za-z0-9]+$ ]]; then',
        'QUARANTINE_APPROVAL_REF',
      ),
    ).toBe(true);
    expect(
      checksWithKernel(
        'python3 -m aria_kernel operator check-ref \\\n  --list \\\n  --ref "${APPROVAL_REF}"',
        'APPROVAL_REF',
      ),
    ).toBe(true);
    expect(
      checksWithKernel('python3 -m aria_kernel operator check-ref --ref "$OTHER"', 'APPROVAL_REF'),
    ).toBe(false);
  });
});
