/**
 * ARIA-MEDIUM-277 — a gap in a scheduled self-hosted lane is REPORTED, never
 * silent.
 *
 * WHY. Two report gaps let the measured starvation (3-7 dataflow runs/day
 * against a 24-slot cadence) pass unnoticed for weeks:
 * - the scheduled-workflow watchdog deliberately treats a pre-job-cancelled
 *   run as "not a verdict about the lane" (ORPHAN-712's freshness logic is
 *   right), but NOTHING ever reported the eviction itself — the very event
 *   that starves the lane was invisible by design;
 * - the dataflow probe that finally ran again reported only its own fresh
 *   green, never how many hourly slots had passed since the previous run.
 *
 * HOW. Both halves are asserted at their real entry points:
 * - the watchdog's actual inline github-script (read from the workflow
 *   file, executed against a fake GitHub API over fixture run lists) must
 *   file an `evicted` incident row for a watched self-hosted lane that has
 *   a cancelled-before-any-job run, WITHOUT changing the freshness verdict;
 * - the dataflow probe's actual missed-slots step (read from the workflow
 *   file) must run tools/watchdog/missed_slots.mjs against the probe
 *   textfile, and the module itself is executed as a real child process
 *   over fixture gh run lists.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import yaml from 'js-yaml';

import { removeFixtureTree } from '../../tools/gates/fixture-tree';

const REPO_ROOT = resolve(__dirname, '..', '..');
const HOUR_MS = 60 * 60 * 1000;

interface WorkflowStep {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
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
  readonly zeroJobRunIds?: readonly number[];
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
    workflows: Object.entries(lanes).map(([workflow, lane]) => ({
      workflow,
      maxAgeHours: 48,
      // The manifest's marker for a lane whose pre-job cancellations are
      // pending-slot evictions worth reporting (self-hosted, one runner).
      selfHostedRunner: lane.zeroJobRunIds !== undefined,
    })),
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
        listJobsForWorkflowRun: async ({ run_id }: { run_id: number }) => {
          // A pre-job eviction created ZERO jobs; every other run has one.
          const owner = Object.entries(lanes).find(([, fake]) =>
            fake.runs.some((candidate) => candidate.id === run_id),
          );
          if (!owner) throw new Error(`unexpected run ${run_id}`);
          return {
            data: {
              total_count: owner[1].zeroJobRunIds?.includes(run_id) ? 0 : 1,
            },
          };
        },
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

function incidentRows(body: string | null, workflow: string): string[] {
  return body?.split('\n').filter((line) => line.startsWith(`| \`${workflow}\` |`)) ?? [];
}

describe('scheduled-workflow watchdog — an eviction is an incident line', () => {
  it('reports a pre-job-cancelled run of a watched self-hosted lane as evicted', async () => {
    const outcome = await runWatchdog({
      'dataflow-integrity-watchdog.yml': {
        state: 'active',
        zeroJobRunIds: [77],
        runs: [
          run(78, 'success', 0.1),
          // Evicted 2.5h ago: cancelled before any job existed.
          run(77, 'cancelled', 2.5),
          run(76, 'success', 3.5),
        ],
      },
    });
    const rows = incidentRows(outcome.issueBody, 'dataflow-integrity-watchdog.yml');
    expect(rows.some((row) => row.includes('evicted'))).toBe(true);
  });

  it('keeps the freshness verdict unchanged — the eviction row is additional', async () => {
    const outcome = await runWatchdog({
      'dataflow-integrity-watchdog.yml': {
        state: 'active',
        zeroJobRunIds: [77],
        runs: [run(78, 'success', 0.1), run(77, 'cancelled', 2.5)],
      },
    });
    const rows = incidentRows(outcome.issueBody, 'dataflow-integrity-watchdog.yml');
    // Exactly one row, the eviction report: the fresh green run still wins
    // the freshness verdict, so no stale/missing row may appear.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('evicted');
    expect(rows[0]).not.toContain('missing');
    expect(rows[0]).not.toContain('success-without-evidence');
  });

  it('does not report evictions for lanes the manifest does not flag', async () => {
    // zeroJobRunIds undefined -> not a self-hosted watched lane: a hosted
    // lane's cancelled run (e.g. its own dedup) is not an eviction report.
    const outcome = await runWatchdog({
      'hosted-lane.yml': {
        state: 'active',
        runs: [run(5, 'success', 0.2), run(4, 'cancelled', 1)],
      },
    });
    expect(incidentRows(outcome.issueBody, 'hosted-lane.yml')).toHaveLength(0);
    expect(outcome.failed).toBeNull();
  });

  it('still alarms as missing when every run of the lane is an eviction', async () => {
    const outcome = await runWatchdog({
      'starved.yml': {
        state: 'active',
        zeroJobRunIds: [10, 11],
        runs: [run(11, 'cancelled', 1), run(10, 'cancelled', 3)],
      },
    });
    const rows = incidentRows(outcome.issueBody, 'starved.yml');
    expect(rows.some((row) => row.includes('missing') || row.includes('evicted'))).toBe(true);
  });
});

describe('dataflow probe — the missed hourly slots are written to the textfile', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'missed-slots-spec-'));
  });

  afterAll(() => {
    removeFixtureTree(tempDir);
  });

  function probeSteps(): WorkflowStep[] {
    const workflow = yaml.load(
      readFileSync(join(REPO_ROOT, '.github/workflows/dataflow-integrity-watchdog.yml'), 'utf8'),
    ) as { jobs: { probe: { steps: WorkflowStep[] } } };
    return workflow.jobs.probe.steps;
  }

  function missedSlotsStep(): WorkflowStep | undefined {
    return probeSteps().find(
      (step) => step.run?.includes('tools/watchdog/missed_slots.mjs') ?? false,
    );
  }

  function runModule(args: readonly string[]): { stdout: string; status: number } {
    try {
      const stdout = execFileSync(
        process.execPath,
        [join(REPO_ROOT, 'tools/watchdog/missed_slots.mjs'), ...args],
        { encoding: 'utf8' },
      );
      return { stdout, status: 0 };
    } catch (error) {
      const err = error as { stdout?: string; status?: number };
      return { stdout: err.stdout ?? '', status: err.status ?? 1 };
    }
  }

  function fixtureRuns(
    entries: ReadonlyArray<{ databaseId: number; createdAt: string; conclusion: string }>,
  ): string {
    const path = join(tempDir, `runs-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify(entries), 'utf8');
    return path;
  }

  it('the probe job runs the missed-slots step against the probe textfile', () => {
    const step = missedSlotsStep();
    expect(step).toBeDefined();
    expect(step?.run).toContain('$RUNNER_TEMP/aqua_probes.prom');
  });

  it('counts every cron slot between the previous run and this one as missed', () => {
    const runsPath = fixtureRuns([
      { databaseId: 101, createdAt: '2026-10-20T10:41:00Z', conclusion: 'success' },
      { databaseId: 100, createdAt: '2026-10-20T05:10:00Z', conclusion: 'success' },
    ]);
    const textfile = join(tempDir, 'slots-gapped.prom');
    const evidence = join(tempDir, 'slots-gapped.json');
    const outcome = runModule([
      '--runs',
      runsPath,
      '--textfile',
      textfile,
      '--evidence',
      evidence,
      '--cron',
      '40 * * * *',
      '--current-run-id',
      '101',
      '--now',
      '2026-10-20T10:45:00Z',
    ]);
    expect(outcome.status).toBe(0);
    // The current run's slot is 10:40; the previous run's slot 04:40 — the
    // five firings between them (05:40..09:40) produced no run.
    expect(readFileSync(textfile, 'utf8')).toContain(
      'probe_missed_slots{workflow="dataflow-integrity-watchdog"} 5',
    );
    expect(JSON.parse(readFileSync(evidence, 'utf8'))).toMatchObject({
      current_run_id: 101,
      previous_run_id: 100,
      missed_slots: 5,
    });
  });

  it('reports zero missed slots for a lane at cadence', () => {
    const runsPath = fixtureRuns([
      { databaseId: 201, createdAt: '2026-10-20T10:41:00Z', conclusion: 'success' },
      { databaseId: 200, createdAt: '2026-10-20T09:41:00Z', conclusion: 'success' },
    ]);
    const textfile = join(tempDir, 'slots-healthy.prom');
    const evidence = join(tempDir, 'slots-healthy.json');
    const outcome = runModule([
      '--runs',
      runsPath,
      '--textfile',
      textfile,
      '--evidence',
      evidence,
      '--cron',
      '40 * * * *',
      '--current-run-id',
      '201',
      '--now',
      '2026-10-20T10:45:00Z',
    ]);
    expect(outcome.status).toBe(0);
    expect(readFileSync(textfile, 'utf8')).toContain(
      'probe_missed_slots{workflow="dataflow-integrity-watchdog"} 0',
    );
    expect(JSON.parse(readFileSync(evidence, 'utf8')).missed_slots).toBe(0);
  });

  it('treats a cancelled previous run as covering nothing (its slot was missed too)', () => {
    const runsPath = fixtureRuns([
      { databaseId: 301, createdAt: '2026-10-20T10:41:00Z', conclusion: 'success' },
      { databaseId: 300, createdAt: '2026-10-20T07:50:00Z', conclusion: 'cancelled' },
    ]);
    const textfile = join(tempDir, 'slots-evicted.prom');
    const evidence = join(tempDir, 'slots-evicted.json');
    const outcome = runModule([
      '--runs',
      runsPath,
      '--textfile',
      textfile,
      '--evidence',
      evidence,
      '--cron',
      '40 * * * *',
      '--current-run-id',
      '301',
      '--now',
      '2026-10-20T10:45:00Z',
    ]);
    expect(outcome.status).toBe(0);
    // Previous slot 07:40; current slot 10:40: 08:40 and 09:40 missed.
    expect(readFileSync(textfile, 'utf8')).toContain(
      'probe_missed_slots{workflow="dataflow-integrity-watchdog"} 2',
    );
  });

  it('survives the first ever run with no previous run to compare', () => {
    const runsPath = fixtureRuns([
      { databaseId: 401, createdAt: '2026-10-20T10:41:00Z', conclusion: 'success' },
    ]);
    const textfile = join(tempDir, 'slots-first.prom');
    const evidence = join(tempDir, 'slots-first.json');
    const outcome = runModule([
      '--runs',
      runsPath,
      '--textfile',
      textfile,
      '--evidence',
      evidence,
      '--cron',
      '40 * * * *',
      '--current-run-id',
      '401',
      '--now',
      '2026-10-20T10:45:00Z',
    ]);
    expect(outcome.status).toBe(0);
    expect(JSON.parse(readFileSync(evidence, 'utf8')).previous_run_id).toBeNull();
    expect(readFileSync(textfile, 'utf8')).toContain(
      'probe_missed_slots{workflow="dataflow-integrity-watchdog"} 0',
    );
  });
});
