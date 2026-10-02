/**
 * Workflow roles invariant (ADR-0019, ARIA-HIGH-256).
 *
 * WHY. ARIA's failing_ci plan source ranks above every finding source, so a
 * red workflow outranks the findings ARIA holds. ADR-0019 limits that slot to
 * a red workflow whose verdict is about `main` or production. The kernel reads
 * `.github/manifests/workflow-roles.json` to learn which workflows those are,
 * and an undeclared workflow counts as `main_verdict`. This spec keeps the
 * manifest true to the files: every workflow is declared once, under the name
 * GitHub reports its runs by (the kernel joins runs to roles on it), and each
 * declared role is checked against what the workflow can see:
 *
 *   - `pr_verdict` needs a pull-request trigger, directly or through a
 *     `workflow_run` on a workflow that has one;
 *   - `observer` names the workflows it observes, each named in its source or
 *     in a `.github/manifests/` file its source loads, and reads runs (a
 *     `workflow_run` trigger or a runs API call in its source).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');
const MANIFEST_DIR = join(REPO_ROOT, '.github', 'manifests');
const MANIFEST_PATH = join(MANIFEST_DIR, 'workflow-roles.json');

const ROLES = ['main_verdict', 'pr_verdict', 'observer'] as const;
type Role = (typeof ROLES)[number];

const PULL_REQUEST_EVENTS = new Set(['pull_request', 'pull_request_target']);
// What reading another workflow's runs looks like in a workflow's source:
// the REST helpers github-script exposes, the REST path, and the gh verbs.
const RUN_READING = new RegExp(
  [
    'listWorkflowRuns',
    'listJobsForWorkflowRun',
    'actions/runs',
    '/runs\\?',
    'gh run (list|view|download|watch)',
  ].join('|'),
);
// A manifest under .github/manifests/ that a workflow loads: an observer's
// watch list may live there instead of in the workflow file itself.
const LOADED_MANIFEST = /\.github\/manifests\/([\w.-]+\.json)/g;

interface RoleEntry {
  workflow: string;
  name: string;
  role: Role;
  reason: string;
  observes?: string[];
}

interface RoleManifest {
  schemaVersion: number;
  workflows: RoleEntry[];
}

interface WorkflowFile {
  file: string;
  name: string | undefined;
  events: Set<string>;
  workflowRunSources: string[];
  source: string;
}

function triggerEvents(on: unknown): Set<string> {
  if (typeof on === 'string') return new Set([on]);
  if (Array.isArray(on)) return new Set(on.map(String));
  if (on && typeof on === 'object') return new Set(Object.keys(on));
  return new Set();
}

function workflowRunSources(on: unknown): string[] {
  if (!on || typeof on !== 'object' || Array.isArray(on)) return [];
  const run = (on as Record<string, unknown>).workflow_run as { workflows?: unknown } | null;
  return Array.isArray(run?.workflows) ? run.workflows.map(String) : [];
}

function readWorkflows(): Map<string, WorkflowFile> {
  const workflows = new Map<string, WorkflowFile>();
  for (const file of readdirSync(WORKFLOW_DIR)
    .filter((n) => /\.ya?ml$/.test(n))
    .sort()) {
    const source = readFileSync(join(WORKFLOW_DIR, file), 'utf-8');
    const doc = (yaml.load(source) ?? {}) as { name?: unknown; on?: unknown };
    workflows.set(file, {
      file,
      name: typeof doc.name === 'string' ? doc.name : undefined,
      events: triggerEvents(doc.on),
      workflowRunSources: workflowRunSources(doc.on),
      source,
    });
  }
  return workflows;
}

/** The workflow file a manifest entry declares; the first test proves it exists. */
function declaredFile(workflows: Map<string, WorkflowFile>, entry: RoleEntry): WorkflowFile {
  const file = workflows.get(entry.workflow);
  if (file === undefined) throw new Error(`${entry.workflow} is not under .github/workflows/`);
  return file;
}

/** The observer's source plus every .github/manifests/ file that source loads. */
function observerSources(file: WorkflowFile): string {
  const loaded = [...file.source.matchAll(LOADED_MANIFEST)]
    .map((match) => join(MANIFEST_DIR, match[1]))
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, 'utf-8'));
  return [file.source, ...loaded].join('\n');
}

describe('workflow roles manifest (ADR-0019)', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as RoleManifest;
  const workflows = readWorkflows();
  const byName = new Map([...workflows.values()].map((w) => [w.name, w]));

  it('declares every workflow file exactly once', () => {
    const declared = manifest.workflows.map((entry) => entry.workflow);
    expect(new Set(declared).size).toBe(declared.length);
    expect([...declared].sort()).toEqual([...workflows.keys()]);
  });

  it('carries no stale entry', () => {
    const stale = manifest.workflows
      .map((entry) => entry.workflow)
      .filter((file) => !existsSync(join(WORKFLOW_DIR, file)));
    expect(stale).toEqual([]);
  });

  it('names each workflow the way GitHub reports its runs, and no name twice', () => {
    // The kernel matches a run's workflowName against `name`; a workflow with
    // no `name:` is reported by its path, and two workflows sharing a name
    // would give one role to both.
    const mismatched = manifest.workflows
      .filter((entry) => workflows.get(entry.workflow)?.name !== entry.name)
      .map((entry) => entry.workflow);
    expect(mismatched).toEqual([]);
    const names = [...workflows.values()].map((w) => w.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('uses only the closed set of roles, each with a one-line reason', () => {
    expect(manifest.schemaVersion).toBe(1);
    const invalid = manifest.workflows.filter(
      (entry) =>
        !(ROLES as readonly string[]).includes(entry.role) ||
        typeof entry.reason !== 'string' ||
        entry.reason.trim() === '' ||
        /\n/.test(entry.reason),
    );
    expect(invalid.map((entry) => entry.workflow)).toEqual([]);
  });

  it('gives a pr_verdict workflow a pull-request trigger, directly or via workflow_run', () => {
    const hasPullRequestTrigger = (file: WorkflowFile): boolean =>
      [...file.events].some((event) => PULL_REQUEST_EVENTS.has(event));
    const triggeredByPullRequest = (file: WorkflowFile): boolean =>
      hasPullRequestTrigger(file) ||
      file.workflowRunSources.some((name) => {
        const upstream = byName.get(name);
        return upstream !== undefined && hasPullRequestTrigger(upstream);
      });
    const unreachable = manifest.workflows
      .filter((entry) => entry.role === 'pr_verdict')
      .filter((entry) => !triggeredByPullRequest(declaredFile(workflows, entry)))
      .map((entry) => entry.workflow);
    expect(unreachable).toEqual([]);
  });

  it('gives an observer a list of existing workflows it observes, and a way to read runs', () => {
    const observers = manifest.workflows.filter((entry) => entry.role === 'observer');
    expect(observers.length).toBeGreaterThan(0);
    for (const entry of observers) {
      const observes = entry.observes ?? [];
      expect({ workflow: entry.workflow, observes: observes.length > 0 }).toEqual({
        workflow: entry.workflow,
        observes: true,
      });
      const missing = observes.filter((file) => file === entry.workflow || !workflows.has(file));
      expect({ workflow: entry.workflow, missing }).toEqual({
        workflow: entry.workflow,
        missing: [],
      });
      const file = declaredFile(workflows, entry);
      // Each observed workflow is one the observer actually names, so the
      // list cannot drift from the watch list the observer runs on.
      const sources = observerSources(file);
      const unnamed = observes.filter((observed) => !sources.includes(observed));
      expect({ workflow: entry.workflow, unnamed }).toEqual({
        workflow: entry.workflow,
        unnamed: [],
      });
      const readsRuns = file.events.has('workflow_run') || RUN_READING.test(file.source);
      expect({ workflow: entry.workflow, readsRuns }).toEqual({
        workflow: entry.workflow,
        readsRuns: true,
      });
    }
  });

  it('declares observed workflows only on observers', () => {
    const misplaced = manifest.workflows
      .filter((entry) => entry.role !== 'observer' && entry.observes !== undefined)
      .map((entry) => entry.workflow);
    expect(misplaced).toEqual([]);
  });
});
