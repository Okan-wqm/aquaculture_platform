/**
 * Platform-wide invariant: a workflow job that RUNS aria-kernel code must
 * first PROVISION aria-kernel.
 *
 * # The failure this closes
 *
 * The coupling between "this step imports `aria_kernel`" and "some earlier
 * step installed the kernel's dependencies" was maintained by hand, per job,
 * in every workflow that touches the kernel — and nothing checked it.
 *
 * `aria-daily-report.yml` ran its preflight step, which imports
 * `aria_kernel.preflight` -> `workflow_contracts` -> `yaml`, twenty-seven
 * lines BEFORE its `pip install -e aria-kernel` step. Every scheduled run
 * from 2026-07-17 onward died with `ModuleNotFoundError: No module named
 * 'yaml'`, so the daily anchor — the committed audit record that stands in
 * for git history — silently stopped being produced for seventeen days.
 * `finding-state-sweep.yml`, `rule-health-report.yml`, `aria-agent-eval.yml`
 * and `aria-runner-capability-probe.yml` imported the kernel with no install
 * step at all, and `aria-daily-report.yml`'s second job had no Python
 * provisioning whatsoever (it never ran, because the first job always died).
 *
 * The watchdog DID report all of this hourly, into a single incident issue.
 * Detection was never the gap; the gap was that a scheduled lane can go
 * quiet for weeks without any gate objecting. This spec is the gate.
 *
 * # What is asserted
 *
 * For every job in `.github/workflows/*.yml`: if any step's `run:` script
 * references the kernel (`aria_kernel`, `PYTHONPATH=aria-kernel`, or
 * `python -m aria_kernel`), then an EARLIER step in the SAME job must be
 * `uses: ./.github/actions/setup-aria-kernel`. Ordering is load-bearing —
 * provisioning after the first import is exactly the defect above — so the
 * check is positional, not merely presence-based.
 *
 * Jobs are checked independently because each GitHub job gets a fresh
 * runner: an install in job A does nothing for job B.
 *
 * # Fixing a failure
 *
 * Add `- uses: ./.github/actions/setup-aria-kernel` as the first
 * Python-touching step of the offending job. Do NOT hand-roll a
 * `pip install` block — a second copy of the provisioning logic is the
 * duplication this invariant exists to prevent, and this spec will still
 * fail because it looks for the action, not for a pip command.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import yaml from 'js-yaml';

const WORKFLOW_DIR = join(__dirname, '..', '..', '.github', 'workflows');
// Z1 (ORPHAN-712) — the dataflow watchdog checks out into a subdirectory,
// so its local action reference carries that prefix. The identity of the
// setup step is its action PATH SUFFIX, not the checkout root it happens
// to live under.
const SETUP_ACTION_SUFFIX = '.github/actions/setup-aria-kernel';
const isSetupAction = (uses: string): boolean =>
  uses.startsWith('./') && uses.endsWith(SETUP_ACTION_SUFFIX);

/** Substrings in a `run:` script that mean "this step executes kernel code". */
const KERNEL_INVOCATION_MARKERS = [
  'aria_kernel',
  'PYTHONPATH=aria-kernel',
  'aria-kernel/aria_kernel',
];

type Step = { uses?: string; run?: string; name?: string };
type Job = { steps?: Step[] };
type Workflow = { jobs?: Record<string, Job> };

function isKernelInvocation(step: Step): boolean {
  const script = step.run;
  if (typeof script !== 'string') return false;
  return KERNEL_INVOCATION_MARKERS.some((marker) => script.includes(marker));
}

function usesSetupAction(step: Step): boolean {
  return typeof step.uses === 'string' && isSetupAction(step.uses.trim());
}

describe('aria-kernel workflow provisioning', () => {
  const workflowFiles = readdirSync(WORKFLOW_DIR).filter((name) => name.endsWith('.yml'));

  it('finds workflows to check (a silent empty sweep would prove nothing)', () => {
    expect(workflowFiles.length).toBeGreaterThan(5);
  });

  it('anchors the auto-cycle job clock immediately after checkout and before kernel setup', () => {
    const workflow = yaml.load(
      readFileSync(join(WORKFLOW_DIR, 'aria-auto-cycle.yml'), 'utf8'),
    ) as Workflow | null;
    const steps = workflow?.jobs?.cycle?.steps ?? [];
    const checkoutIndex = steps.findIndex((step) => step.uses?.startsWith('actions/checkout@'));
    const anchorIndexes = steps.flatMap((step, index) =>
      step.name === 'Anchor the job launch epoch' ? [index] : [],
    );
    const setupIndex = steps.findIndex(usesSetupAction);

    expect(checkoutIndex).toBeGreaterThanOrEqual(0);
    expect(anchorIndexes).toHaveLength(1);
    expect(anchorIndexes[0]).toBe(checkoutIndex + 1);
    expect(setupIndex).toBe(checkoutIndex + 2);
  });

  it('provisions the kernel before any job step that runs kernel code', () => {
    const violations: string[] = [];

    for (const file of workflowFiles) {
      const workflow = yaml.load(readFileSync(join(WORKFLOW_DIR, file), 'utf8')) as Workflow | null;
      const jobs = workflow?.jobs ?? {};

      for (const [jobId, job] of Object.entries(jobs)) {
        const steps = job?.steps ?? [];
        let provisioned = false;

        for (const [index, step] of steps.entries()) {
          if (usesSetupAction(step)) {
            provisioned = true;
            continue;
          }
          if (!provisioned && isKernelInvocation(step)) {
            violations.push(
              `${file} job "${jobId}" step ${index + 1}` +
                `${step.name ? ` ("${step.name}")` : ''} runs kernel code before ` +
                `any \`uses: ./**/${SETUP_ACTION_SUFFIX}\` step in that job`,
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps the provisioning action itself installing from pyproject, not a copied list', () => {
    // Checked against the parsed SCRIPT, not the file text: the action's
    // header prose legitimately discusses `pip install`, and a text scan
    // that cannot tell documentation from instruction would force the
    // explanation out of the file to keep the gate quiet.
    const action = yaml.load(
      readFileSync(
        join(__dirname, '..', '..', '.github', 'actions', 'setup-aria-kernel', 'action.yml'),
        'utf8',
      ),
    ) as { runs?: { steps?: Step[] } } | null;
    const scripts = (action?.runs?.steps ?? [])
      .map((step) => step.run)
      .filter((run): run is string => typeof run === 'string');
    expect(scripts.length).toBeGreaterThan(0);

    const installLines = scripts
      .join('\n')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !line.startsWith('#') && line.includes('pip install'));

    // Dependencies are READ from pyproject and installed by name; the
    // package itself is never installed (that would give `import
    // aria_kernel` a second source and make this parse dead code, which is
    // why aria-doc-runtime-ssot.spec.ts bans `pip install -e aria-kernel`).
    const script = scripts.join('\n');
    expect(script).toContain('tomllib.load');
    expect(script).toContain('aria-kernel/pyproject.toml');
    expect(script).not.toMatch(/pip install[^\n]*\s-e\s+aria-kernel/);

    // A dependency named literally here would be a second source of truth
    // for what the kernel needs; pyproject.toml is the only one.
    const allowed = new Set(['python3 -m pip install --upgrade pip']);
    expect(installLines.filter((line) => !allowed.has(line))).toEqual([]);
  });
});
