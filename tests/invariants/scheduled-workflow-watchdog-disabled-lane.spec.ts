/**
 * The Scheduled Workflow Watchdog reports a DISABLED lane as disabled.
 *
 * WHY. The watchdog judged every manifest lane by its newest completed run
 * only. A lane the operator turned off (`disabled_manually`) or GitHub turned
 * off (`disabled_inactivity`, after 60 days without repository activity) keeps
 * its last run forever, so the incident said something nobody measured:
 * aria-merge-runner, disabled on 2026-09-28, was filed on 2026-10-04 as
 * `failure | 154.9h` (issue #1005, run 37221005747) — a failing lane, not a
 * stopped one — and aria-state-maintenance, disabled on 2026-10-04 after a
 * green run, filed nothing at all and would have surfaced two days later as a
 * stale `success`. Neither verdict tells the on-call reader the lane cannot
 * run. The workflow's own `state` is the fact; the incident now names it.
 *
 * HOW. This spec runs the watchdog's real inline github-script (read from the
 * workflow file, not copied) against a fake GitHub API, so the assertion is on
 * the behaviour the step executes, not on strings it happens to contain.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');
const HOUR_MS = 60 * 60 * 1000;

interface WorkflowStep {
  readonly name?: string;
  readonly uses?: string;
  readonly with?: { readonly script?: string };
}

interface FakeRun {
  readonly id: number;
  readonly status: 'completed' | 'in_progress';
  readonly conclusion: string | null;
  readonly created_at: string;
  readonly html_url: string;
}

interface FakeLane {
  readonly state: string;
  readonly runs: readonly FakeRun[];
}

interface WatchdogOutcome {
  readonly failed: string | null;
  readonly issueBody: string | null;
}

function watchdogScript(): string {
  const workflow = yaml.load(
    readFileSync(join(REPO_ROOT, '.github/workflows/scheduled-workflow-watchdog.yml'), 'utf8'),
  ) as { jobs: { watchdog: { steps: WorkflowStep[] } } };
  const step = workflow.jobs.watchdog.steps.find((candidate) =>
    candidate.uses?.startsWith('actions/github-script@'),
  );
  const script = step?.with?.script;
  if (!script) throw new Error('scheduled-workflow-watchdog.yml has no github-script step');
  return script;
}

function run(id: number, conclusion: string, ageHours: number): FakeRun {
  return {
    id,
    status: 'completed',
    conclusion,
    created_at: new Date(Date.now() - ageHours * HOUR_MS).toISOString(),
    html_url: `https://github.com/o/r/actions/runs/${id}`,
  };
}

async function runWatchdog(lanes: Record<string, FakeLane>): Promise<WatchdogOutcome> {
  const manifest = {
    incidentTitle: '[scheduled-workflow-watchdog] Scheduled workflow incident',
    workflows: Object.keys(lanes).map((workflow) => ({ workflow, maxAgeHours: 48 })),
  };
  let failed: string | null = null;
  let issueBody: string | null = null;
  const lane = (workflowId: string): FakeLane => {
    const found = lanes[workflowId];
    if (!found) throw new Error(`unexpected workflow ${workflowId}`);
    return found;
  };
  const github = {
    rest: {
      actions: {
        getWorkflow: async ({ workflow_id }: { workflow_id: string }) => ({
          data: { state: lane(workflow_id).state },
        }),
        listWorkflowRuns: async ({ workflow_id }: { workflow_id: string }) => ({
          data: { workflow_runs: lane(workflow_id).runs },
        }),
        listJobsForWorkflowRun: async () => ({ data: { total_count: 1 } }),
        listWorkflowRunArtifacts: async () => ({ data: { artifacts: [] } }),
      },
      issues: {
        listForRepo: 'issues.listForRepo',
        create: async ({ body }: { body: string }) => {
          issueBody = body;
          return { data: {} };
        },
        update: async ({ body }: { body?: string }) => {
          issueBody = body ?? issueBody;
          return { data: {} };
        },
        createComment: async () => ({ data: {} }),
      },
    },
    paginate: async () => [],
  };
  const core = {
    setFailed: (message: string) => {
      failed = message;
    },
    notice: () => undefined,
  };
  const context = { repo: { owner: 'o', repo: 'r' } };
  const fakeRequire = (path: string): unknown => {
    if (!path.endsWith('/.github/manifests/scheduled-workflows.json')) {
      throw new Error(`unexpected require ${path}`);
    }
    return manifest;
  };
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
    ...args: string[]
  ) => (...values: unknown[]) => Promise<void>;
  const body = new AsyncFunction(
    'github',
    'context',
    'core',
    'require',
    'process',
    watchdogScript(),
  );
  await body(github, context, core, fakeRequire, { env: { GITHUB_WORKSPACE: '/workspace' } });
  return { failed, issueBody };
}

function incidentRow(body: string | null, workflow: string): string | undefined {
  return body?.split('\n').find((line) => line.startsWith(`| \`${workflow}\` |`));
}

describe('scheduled-workflow watchdog — a disabled lane is reported as disabled', () => {
  it('names a manually disabled lane by its state, not by its last run conclusion', async () => {
    const outcome = await runWatchdog({
      'merge-runner.yml': { state: 'disabled_manually', runs: [run(1, 'failure', 154.9)] },
    });
    expect(outcome.failed).toBe('1 scheduled workflow(s) are stale or failing');
    const row = incidentRow(outcome.issueBody, 'merge-runner.yml');
    expect(row).toBeDefined();
    expect(row).toContain('| disabled_manually |');
    expect(row).not.toContain('| failure |');
  });

  it('files a disabled lane whose last run was fresh and green', async () => {
    const outcome = await runWatchdog({
      'state-maintenance.yml': { state: 'disabled_manually', runs: [run(2, 'success', 1)] },
    });
    expect(incidentRow(outcome.issueBody, 'state-maintenance.yml')).toContain(
      '| disabled_manually |',
    );
  });

  it('names a lane GitHub disabled for inactivity', async () => {
    const outcome = await runWatchdog({
      'weekly.yml': { state: 'disabled_inactivity', runs: [run(3, 'success', 30)] },
    });
    expect(incidentRow(outcome.issueBody, 'weekly.yml')).toContain('| disabled_inactivity |');
  });

  it('leaves an active, fresh, green lane out of the incident', async () => {
    const outcome = await runWatchdog({
      'healthy.yml': { state: 'active', runs: [run(4, 'success', 1)] },
    });
    expect(outcome.failed).toBeNull();
    expect(outcome.issueBody).toBeNull();
  });

  it('still judges an active lane by its newest completed run', async () => {
    const outcome = await runWatchdog({
      'red.yml': { state: 'active', runs: [run(5, 'failure', 1)] },
    });
    expect(incidentRow(outcome.issueBody, 'red.yml')).toContain('| failure |');
  });
});
