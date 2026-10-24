/**
 * SE-1 (iii) — the TypeScript code-fact side and the kernel name an application identically.
 *
 * # Why
 *
 * The service-expertise plan (PLAN.md §2 row "Path → service/project key", item 2; SO-07) makes
 * `impact_graph.project_for_path` over the `project_roots` map of `cached_service_analysis_order`
 * the ONE service key. The code-fact bridge (SE-3) will hand the kernel per-application facts from
 * `tools/gates/event-consumer-index.ts`, whose `applicationNames` keys an app by its nx identity
 * (`project.json` `name`, else the directory). The kernel's conventional discovery keys every
 * `apps/<dir>` by the directory. When the two disagree, a fact the bridge files under one name is
 * looked up by the kernel under another, and the cross-service edge silently disappears.
 *
 * This repository's apps all declare their directory name today, so the live tree cannot show the
 * split; the fixture below declares a `project.json` name that differs from its directory, which is
 * exactly what nx permits and what `_marker_project_name` already treats as authoritative for
 * marker-discovered projects.
 *
 * # What
 *
 * For every `apps/<dir>` in the fixture, the application name the TS scan attributes a site to
 * (`scanEventConsumers(...).entries[].application`, the public face of `applicationNames`) equals
 * `project_for_path("apps/<dir>/src/...", project_roots)` from the kernel's own cache writer.
 * Lib sites are attributed to each wiring app and are never an endpoint; that rule is SE-3's (iv).
 *
 * SE-1 round 2 (review-r1 note (b)): the two sides read an edge-case `project.json` by two rules.
 * The kernel stripped whitespace from `name` and fell back to the directory name on malformed
 * JSON; the TS side keeps the raw name and throws. The reviewer's probe got `spaced` from one side
 * and ` spaced ` from the other. Both sides follow ONE rule: for every edge-case manifest below
 * they give the same outcome — the same name, or both refuse.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { scanEventConsumers } from '../../tools/gates/event-consumer-index';
import {
  indexFixtureTree,
  makeFixtureTree,
  removeFixtureTree,
} from '../../tools/gates/fixture-tree';

const REPO_ROOT = resolve(__dirname, '..', '..');

const BUS = [
  'export interface IEventBus {',
  '  subscribeWildcard(eventType: string, handler: object): Promise<void>;',
  '}',
  '',
].join('\n');

const SUBSCRIBER = (event: string): string =>
  [
    "import type { IEventBus } from '../../../platform/libs/event-bus/src/event-bus';",
    'export class Subscriber {',
    '  constructor(private readonly bus: IEventBus) {}',
    '  async start(): Promise<void> {',
    `    await this.bus.subscribeWildcard('${event}', this);`,
    '  }',
    '}',
    '',
  ].join('\n');

/** apps/<dir> -> its project.json `name` (absent = no project.json). */
const APPS: Record<string, string | null> = {
  'ingest-svc': 'sensor-ingest',
  'plain-service': null,
};

function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text, 'utf8');
  }
}

function subscriberPath(dir: string): string {
  return `apps/${dir}/src/subscriber.ts`;
}

/** The kernel's answer, through the one owner over the map its cache writer publishes. */
function kernelApplicationNames(repo: string, tools: string): Record<string, string | null> {
  const script = [
    'import json, sys',
    'from aria_kernel.impact_graph import cached_service_analysis_order, project_for_path',
    'repo, tools, paths = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])',
    'roots = cached_service_analysis_order(workspace_root=repo, base_dir=tools)["project_roots"]',
    'print(json.dumps({p: project_for_path(p, roots) for p in paths}))',
  ].join('\n');
  const dirs = Object.keys(APPS);
  const byPath = JSON.parse(
    execFileSync('python3', ['-c', script, repo, tools, JSON.stringify(dirs.map(subscriberPath))], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: 'aria-kernel', PYTHONDONTWRITEBYTECODE: '1' },
    }),
  ) as Record<string, string | null>;
  return Object.fromEntries(dirs.map((dir) => [dir, byPath[subscriberPath(dir)] ?? null]));
}

/** The TS scan's answer: the application each app's own subscription site is filed under. */
function tsApplicationNames(repo: string): Record<string, string | null> {
  const index = scanEventConsumers(repo);
  return Object.fromEntries(
    Object.keys(APPS).map((dir) => {
      const entry = index.entries.find((e) => e.site.startsWith(`${subscriberPath(dir)}:`));
      return [dir, entry?.application ?? null];
    }),
  );
}

describe('SE-1 (iii) — applicationNames(apps) == project_roots(apps)', () => {
  const repo = makeFixtureTree('se1-service-key-repo-');
  const tools = makeFixtureTree('se1-service-key-tools-');

  beforeAll(() => {
    const files: Record<string, string> = { 'platform/libs/event-bus/src/event-bus.ts': BUS };
    for (const [dir, declared] of Object.entries(APPS)) {
      files[subscriberPath(dir)] = SUBSCRIBER(`${dir}-happened`);
      if (declared !== null) files[`apps/${dir}/project.json`] = JSON.stringify({ name: declared });
    }
    writeTree(repo, files);
    // Both sides read the tree's TRACKED files (SE-3-R2 corrective R1), so the fixture's files
    // must be in its index; an unindexed tree is a refusal on both sides, not a parity.
    indexFixtureTree(repo);
  });

  afterAll(() => {
    removeFixtureTree(repo);
    removeFixtureTree(tools);
  });

  it('names every app the same on both sides of the bridge', () => {
    const ts = tsApplicationNames(repo);
    const kernel = kernelApplicationNames(repo, tools);
    // Both sides must actually see every app: an empty read would make the parity vacuous.
    for (const dir of Object.keys(APPS)) {
      expect(ts[dir]).not.toBeNull();
      expect(kernel[dir]).not.toBeNull();
    }
    expect(kernel).toEqual(ts);
  }, 120_000);
});

/** apps/<dir> -> the raw text of its `project.json` (edge cases of the identity rule). */
const EDGE_MANIFESTS: Record<string, string> = {
  'spaced-svc': JSON.stringify({ name: ' spaced-ingest ' }),
  'malformed-svc': '{"name": "malformed-ingest",',
};

type Outcome = { name: string | null } | { refused: true };

/** The text a failed read reports: its message, plus a child process's captured stderr. */
function failureText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr = 'stderr' in error ? String(error.stderr) : '';
  return `${error.message}\n${stderr}`;
}

/**
 * A read's outcome. Only a refusal that names `manifest` counts as the manifest rule refusing:
 * any other failure (an unreadable tree, a crash) is rethrown, so two sides that both fail for a
 * reason unrelated to the manifest can never agree on `{ refused: true }` and pass vacuously.
 */
function outcomeOf(manifest: string, read: () => string | null): Outcome {
  try {
    return { name: read() };
  } catch (error) {
    if (failureText(error).includes(manifest)) return { refused: true };
    throw error;
  }
}

describe('SE-1 round 2 — both sides read an edge-case project.json by one rule', () => {
  it.each(Object.entries(EDGE_MANIFESTS))(
    '%s: the kernel and the TS scan give the same outcome',
    (dir, manifest) => {
      const repo = makeFixtureTree('se1-r2-manifest-repo-');
      const tools = makeFixtureTree('se1-r2-manifest-tools-');
      try {
        writeTree(repo, {
          'platform/libs/event-bus/src/event-bus.ts': BUS,
          [subscriberPath(dir)]: SUBSCRIBER(`${dir}-happened`),
          [`apps/${dir}/project.json`]: manifest,
        });
        indexFixtureTree(repo);
        const manifestPath = `apps/${dir}/project.json`;
        const ts = outcomeOf(manifestPath, () => {
          const index = scanEventConsumers(repo);
          const entry = index.entries.find((e) => e.site.startsWith(`${subscriberPath(dir)}:`));
          return entry?.application ?? null;
        });
        const kernel = outcomeOf(manifestPath, () => {
          const script = [
            'import json, sys',
            'from aria_kernel.impact_graph import cached_service_analysis_order, project_for_path',
            'repo, tools, path = sys.argv[1], sys.argv[2], sys.argv[3]',
            'roots = cached_service_analysis_order(workspace_root=repo, base_dir=tools)["project_roots"]',
            'print(json.dumps(project_for_path(path, roots)))',
          ].join('\n');
          return JSON.parse(
            execFileSync('python3', ['-c', script, repo, tools, subscriberPath(dir)], {
              cwd: REPO_ROOT,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, PYTHONPATH: 'aria-kernel', PYTHONDONTWRITEBYTECODE: '1' },
            }),
          ) as string | null;
        });
        // A side that read the tree but filed the site under no application is neither a name
        // nor a refusal; letting two such reads agree would make the parity vacuous.
        expect(ts).not.toEqual({ name: null });
        expect(kernel).not.toEqual({ name: null });
        expect(kernel).toEqual(ts);
      } finally {
        removeFixtureTree(repo);
        removeFixtureTree(tools);
      }
    },
    120_000,
  );
});
