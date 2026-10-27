#!/usr/bin/env ts-node
/**
 * Integration tests for tools/gates/plan-coverage-witness.ts.
 *
 * The witness is a CLI (main() runs when it is the entry module, matching
 * the ripple-tracer design), so the spec exercises it as a subprocess against
 * the fixtures under tools/gates/fixtures/plan-coverage/ — exit codes and
 * the stdout JSON shape ARE the contract that aria_kernel/plan_coverage.py
 * depends on, so that is exactly what gets pinned.
 *
 * SE-4 (service-expertise PLAN §2 'Service impact closure'): the closure has one
 * owner, the kernel's impact_graph.impact_closure, which hands the witness its
 * node set as `closure_nodes`. Which applications consume an event, the
 * services.yaml reading behind it and the ARIA-HIGH-306/313 live cases moved
 * with that computation: tools/gates/event-consumer-index.spec.ts (the code-fact
 * bridge and eventConsumersFor) and tools/gates/nats-services.spec.ts (the SSoT
 * reader) pin them; aria-kernel/tests/test_impact_closure.py pins the walk.
 *
 * Invoke via:
 *   ts-node --project tools/gates/tsconfig.json tools/gates/plan-coverage-witness.spec.ts
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { after } from 'node:test';

import { indexFixtureTree } from './fixture-git-index';
import { removeFixtureTree } from './fixture-tree';

const GATE_DIR = dirname(resolve(__filename));
const REPO_ROOT = resolve(GATE_DIR, '..', '..');
const WITNESS = join(GATE_DIR, 'plan-coverage-witness.ts');
const FIXTURES = join(GATE_DIR, 'fixtures', 'plan-coverage');
const GRAPH = join(FIXTURES, 'nx-graph.json');
const FIXTURE_REPO = join(FIXTURES, 'repo');

/**
 * Throwaway directories this spec creates, removed when it ends. Every
 * directory the spec makes comes from scratchDir (ARIA-LOW-558: three helpers
 * made their own and left one directory per witness run in the temp dir).
 */
const scratchDirs: string[] = [];
after(() => {
  for (const dir of scratchDirs) removeFixtureTree(dir);
});

/** A throwaway directory under the system temp dir, removed when the spec ends. */
function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

interface EventConsumerIndexLedger {
  files_scanned: number;
  sites: number;
  entries: number;
  unresolved: string[];
  unattributed: string[];
}

interface WitnessRun {
  readonly exitCode: number;
  readonly report: {
    verdict: string;
    closure: {
      projects: { name: string; reason: string }[];
      closure_nodes: { node_id: string; kind: string; why: string }[];
      migration_couplings: { service: string }[];
    };
    uncovered: { node_id: string; kind: string; why: string }[];
    waived: { node_id: string; reason: string }[];
    unmapped_paths: string[];
    ledger: {
      event_consumer_index: EventConsumerIndexLedger | null;
    };
    inputs_hash: string;
  };
  readonly stdout: string;
}

function runWitness(input: object, extraArgs: string[] = []): WitnessRun {
  const dir = scratchDir('plan-coverage-spec-');
  const inputPath = join(dir, 'input.json');
  writeFileSync(inputPath, JSON.stringify(input), 'utf8');
  const args = [
    'ts-node',
    '--project',
    join(REPO_ROOT, 'tools', 'gates', 'tsconfig.json'),
    WITNESS,
    '--input',
    inputPath,
    '--graph',
    GRAPH,
    '--repo-root',
    FIXTURE_REPO,
    ...extraArgs,
  ];
  try {
    const stdout = execFileSync('npx', args, { cwd: REPO_ROOT, encoding: 'utf8' });
    return { exitCode: 0, report: JSON.parse(stdout) as WitnessRun['report'], stdout };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string };
    const stdout = failed.stdout ?? '';
    return {
      exitCode: failed.status ?? -1,
      report: stdout.trim().startsWith('{')
        ? (JSON.parse(stdout) as WitnessRun['report'])
        : ({} as WitnessRun['report']),
      stdout,
    };
  }
}

/** Nodes the kernel's closure hands in: farm-shared's two dependents, reached from it. */
const FARM_SHARED_DEPENDENTS = ['farm-service', 'notification-service'].map((project) => ({
  node_id: `project:${project}`,
  kind: 'nx_project',
  why: 'import from farm-shared',
  reached_from: 'farm-shared',
}));

void test('a dependents-of group waiver covers every given node reached from the project (exit 0)', () => {
  const run = runWitness({
    schema_version: 1,
    affected_paths: ['libs/farm-shared/src/index.ts'],
    waivers: [
      { node: 'dependents-of:farm-shared', reason: 'type-only change, tsc closure verified' },
    ],
    closure_nodes: FARM_SHARED_DEPENDENTS,
  });
  assert.equal(run.exitCode, 0);
  assert.equal(run.report.verdict, 'covered_with_waivers');
  assert.equal(run.report.uncovered.length, 0);
  assert.equal(run.report.waived.length, 2);
});

void test('an exact node waiver covers only the named node', () => {
  const run = runWitness({
    schema_version: 1,
    affected_paths: ['libs/farm-shared/src/index.ts'],
    waivers: [{ node: 'project:farm-service', reason: 'consumer verified unaffected' }],
    closure_nodes: FARM_SHARED_DEPENDENTS,
  });
  assert.equal(run.exitCode, 1);
  assert.deepEqual(
    run.report.uncovered.map((n) => n.node_id),
    ['project:notification-service'],
  );
  assert.deepEqual(
    run.report.waived.map((n) => n.node_id),
    ['project:farm-service'],
  );
});

void test('an input without the closure node set is an environment error (exit 2), not a covered plan', () => {
  const run = runWitness({
    schema_version: 1,
    affected_paths: ['libs/farm-shared/src/index.ts'],
    waivers: [],
  });
  assert.equal(run.exitCode, 2);
  assert.equal(run.stdout, '');
});

// --- SE-4 (service-expertise PLAN §2 'Service impact closure', §8 SE-4 (iv)) ---------------------
//
// The closure has one owner, aria_kernel/impact_graph.py: plan_coverage hands the witness the
// closure's node set as `closure_nodes` ({node_id, kind, why}; the key is the test writer's) and
// the witness reports gaps against it. It computes no `project:` or `event-consumer:` node of its
// own; it keeps `migration:` nodes, `event-consumer-unresolved:` sites, waivers and the coverage
// diff.

/** Closure node ids the witness owns no more: everything but migration and unresolved sites. */
function closureNodeIds(run: WitnessRun): string[] {
  return run.report.uncovered
    .map((n) => n.node_id)
    .filter((id) => !id.startsWith('migration:') && !id.startsWith('event-consumer-unresolved:'))
    .sort();
}

const GATEWAY_NODE = {
  node_id: 'project:gateway-api',
  kind: 'nx_project',
  why: 'contract:gateway_subgraph at infrastructure/apollo-router/subgraphs.json:14',
};

void test('SE-4 (iv): given a node set, the witness reports gaps against it and adds no nx reverse dependent', () => {
  const run = runWitness({
    schema_version: 1,
    affected_paths: ['libs/farm-shared/src/index.ts'],
    waivers: [],
    closure_nodes: [GATEWAY_NODE],
  });
  assert.equal(run.exitCode, 1, run.stdout);
  // The fixture nx graph makes farm-service and notification-service reverse dependents of
  // farm-shared; neither is in the given set, so neither is a node.
  assert.deepEqual(closureNodeIds(run), ['project:gateway-api']);
});

void test('SE-4 (iv): given a node set, a touched event contract adds no event-consumer node of its own', () => {
  const run = runWitness({
    schema_version: 1,
    affected_paths: ['libs/event-contracts/src/farm-events.ts'],
    waivers: [],
    closure_nodes: [],
  });
  // The fixture services.yaml grants notification-service BatchHarvested: today that grant makes
  // event-consumer:notification-service:BatchHarvested, and the graph makes project: nodes.
  assert.deepEqual(closureNodeIds(run), [], JSON.stringify(run.report.uncovered));
  assert.equal(run.exitCode, 0, run.stdout);
});

void test('SE-4 (iv): a waiver still covers a node of the given set', () => {
  const run = runWitness({
    schema_version: 1,
    affected_paths: ['libs/farm-shared/src/index.ts'],
    waivers: [{ node: 'project:gateway-api', reason: 'schema unchanged, verified' }],
    closure_nodes: [GATEWAY_NODE],
  });
  assert.equal(run.exitCode, 0, run.stdout);
  assert.equal(run.report.verdict, 'covered_with_waivers');
  assert.deepEqual(
    run.report.waived.map((n) => n.node_id),
    ['project:gateway-api'],
  );
});

/** A throwaway repository with a minimal event bus, removed when the spec ends. */
function writeCodeRepo(listener: string): string {
  const root = scratchDir('plan-coverage-code-');
  const files: Record<string, string> = {
    'libs/event-contracts/src/farm-events.ts': readFileSync(
      join(FIXTURE_REPO, 'libs', 'event-contracts', 'src', 'farm-events.ts'),
      'utf8',
    ),
    'platform/libs/event-bus/src/event-bus.ts': [
      'export class EventBus {',
      '  async subscribeWildcard(eventType: string, handler: object): Promise<void> {',
      '    void eventType;',
      '    void handler;',
      '  }',
      '}',
      '',
    ].join('\n'),
    'apps/demo-service/src/demo.listener.ts': listener,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text, 'utf8');
  }
  // The consumer scan reads the tree's tracked files (git ls-files).
  return indexFixtureTree(root);
}

const DEMO_IMPORT = "import { EventBus } from '../../../platform/libs/event-bus/src/event-bus';";

void test('ARIA-HIGH-313: a subscription the scan cannot resolve is an uncovered node, never a silent pass', () => {
  const repo = writeCodeRepo(
    [
      DEMO_IMPORT,
      'declare function runtimeEventType(): string;',
      'export class DemoListener {',
      '  constructor(private readonly bus: EventBus) {}',
      '  async start(): Promise<void> {',
      '    await this.bus.subscribeWildcard(runtimeEventType(), this);',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  const run = runWitness(
    {
      schema_version: 1,
      affected_paths: ['libs/event-contracts/src/farm-events.ts'],
      waivers: [],
      closure_nodes: [],
    },
    ['--repo-root', repo],
  );
  assert.equal(run.exitCode, 1, run.stdout);
  assert.ok(
    run.report.uncovered.some(
      (n) =>
        n.kind === 'event_consumer' &&
        n.node_id ===
          'event-consumer-unresolved:demo-service:apps/demo-service/src/demo.listener.ts:6',
    ),
    JSON.stringify(run.report.uncovered),
  );
});

void test('an entity edit without a migration surfaces migration:<svc>; with one it does not', () => {
  const withoutMigration = runWitness({
    schema_version: 1,
    affected_paths: ['apps/farm-service/src/batch/entities/batch.entity.ts'],
    waivers: [],
    closure_nodes: [],
  });
  assert.equal(withoutMigration.exitCode, 1);
  assert.deepEqual(
    withoutMigration.report.uncovered.map((n) => n.node_id),
    ['migration:farm-service'],
  );
  const withMigration = runWitness({
    schema_version: 1,
    affected_paths: [
      'apps/farm-service/src/batch/entities/batch.entity.ts',
      'apps/farm-service/src/database/migrations/1800000000000-add-batch-column.ts',
    ],
    waivers: [],
    closure_nodes: [],
  });
  assert.equal(withMigration.exitCode, 0);
  assert.equal(withMigration.report.verdict, 'covered');

  // ARIA-AUDIT-056: a migration path that does not CONTENT-BIND to the
  // touched entity is not coverage. The old path-only predicate accepted
  // any migration-shaped path — even one naming a different schema.
  const unrelated = runWitness({
    schema_version: 1,
    affected_paths: [
      'apps/farm-service/src/batch/entities/batch.entity.ts',
      'apps/farm-service/src/database/migrations/1800000000001-unrelated.ts',
    ],
    waivers: [],
    closure_nodes: [],
  });
  assert.equal(unrelated.exitCode, 1);
  assert.deepEqual(
    unrelated.report.uncovered.map((n) => n.node_id),
    ['migration:farm-service'],
  );
});

void test('paths owned by no nx project are unmapped, never gaps', () => {
  const run = runWitness({
    schema_version: 1,
    affected_paths: [
      'docs/adr/041-aria-narrow-autonomous-merge-lane.md',
      '.claude/agents/aria-drafter.md',
    ],
    waivers: [],
    closure_nodes: [],
  });
  assert.equal(run.exitCode, 0);
  assert.equal(run.report.verdict, 'covered');
  assert.equal(run.report.unmapped_paths.length, 2);
});

void test('closure over max_nodes collapses to a single closure:oversized gap', () => {
  const run = runWitness({
    schema_version: 1,
    affected_paths: ['libs/farm-shared/src/index.ts'],
    waivers: [],
    closure_nodes: FARM_SHARED_DEPENDENTS,
    options: { max_nodes: 1 },
  });
  assert.equal(run.exitCode, 1);
  assert.deepEqual(
    run.report.uncovered.map((n) => n.node_id),
    ['closure:oversized'],
  );
});

void test('output is deterministic — identical inputs produce identical stdout', () => {
  const input = {
    schema_version: 1,
    affected_paths: [
      'libs/farm-shared/src/index.ts',
      'apps/farm-service/src/batch/entities/batch.entity.ts',
    ],
    waivers: [{ node: 'dependents-of:farm-shared', reason: 'verified' }],
    closure_nodes: FARM_SHARED_DEPENDENTS,
  };
  const first = runWitness(input);
  const second = runWitness(input);
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.report.inputs_hash, second.report.inputs_hash);
});

void test('missing input file is an environment error (exit 2)', () => {
  try {
    execFileSync(
      'npx',
      [
        'ts-node',
        '--project',
        join(REPO_ROOT, 'tools', 'gates', 'tsconfig.json'),
        WITNESS,
        '--input',
        '/nonexistent/input.json',
        '--graph',
        GRAPH,
        '--repo-root',
        FIXTURE_REPO,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    assert.fail('expected exit 2');
  } catch (error) {
    assert.equal((error as { status?: number }).status, 2);
  }
});

void test('unreadable graph is an environment error (exit 2), not an empty covered verdict', () => {
  const dir = scratchDir('plan-coverage-spec-');
  const inputPath = join(dir, 'input.json');
  writeFileSync(
    inputPath,
    JSON.stringify({
      schema_version: 1,
      affected_paths: ['libs/farm-shared/src/index.ts'],
      waivers: [],
      closure_nodes: FARM_SHARED_DEPENDENTS,
    }),
    'utf8',
  );
  try {
    execFileSync(
      'npx',
      [
        'ts-node',
        '--project',
        join(REPO_ROOT, 'tools', 'gates', 'tsconfig.json'),
        WITNESS,
        '--input',
        inputPath,
        '--graph',
        '/nonexistent/nx-graph.json',
        '--repo-root',
        FIXTURE_REPO,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    assert.fail('expected exit 2');
  } catch (error) {
    assert.equal((error as { status?: number }).status, 2);
  }
});

/**
 * ARIA-LOW-558: without --graph the witness builds the nx graph itself into a
 * temp directory. A fake `npx` first on PATH stands in for `npx nx graph
 * --file=<path>` (it copies the fixture graph, or fails), and TMPDIR points at
 * an empty directory, so whatever the witness leaves behind is visible there.
 */
function runWitnessBuildingItsGraph(fakeNx: 'writes-graph' | 'fails'): {
  exitCode: number;
  verdict: string | undefined;
  leftovers: string[];
} {
  const sandbox = scratchDir('plan-coverage-tmp-');
  const isolatedTmp = join(sandbox, 'tmp');
  const fakeBin = join(sandbox, 'bin');
  mkdirSync(isolatedTmp);
  mkdirSync(fakeBin);
  const inputPath = join(sandbox, 'input.json');
  writeFileSync(
    inputPath,
    JSON.stringify({
      schema_version: 1,
      affected_paths: ['libs/farm-shared/src/index.ts'],
      waivers: [],
      closure_nodes: FARM_SHARED_DEPENDENTS,
    }),
    'utf8',
  );
  const fakeNpx = join(fakeBin, 'npx');
  writeFileSync(
    fakeNpx,
    fakeNx === 'writes-graph'
      ? '#!/bin/sh\nfor a in "$@"; do case "$a" in --file=*) cp "$FAKE_NX_GRAPH" "${a#--file=}";; esac; done\n'
      : '#!/bin/sh\necho "nx graph failed" >&2\nexit 1\n',
    'utf8',
  );
  chmodSync(fakeNpx, 0o755);
  let exitCode = 0;
  let stdout = '';
  try {
    stdout = execFileSync(
      process.execPath,
      [
        require.resolve('ts-node/dist/bin'),
        '--project',
        join(REPO_ROOT, 'tools', 'gates', 'tsconfig.json'),
        WITNESS,
        '--input',
        inputPath,
        '--repo-root',
        FIXTURE_REPO,
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          TMPDIR: isolatedTmp,
          FAKE_NX_GRAPH: GRAPH,
        },
      },
    );
  } catch (error) {
    const failed = error as { status?: number; stdout?: string };
    exitCode = failed.status ?? -1;
    stdout = failed.stdout ?? '';
  }
  const report = stdout.trim().startsWith('{')
    ? (JSON.parse(stdout) as { verdict?: string })
    : undefined;
  return {
    exitCode,
    verdict: report?.verdict,
    leftovers: readdirSync(isolatedTmp).filter((name) => name.startsWith('plan-coverage-')),
  };
}

void test('a graph the witness builds itself leaves no temp directory behind', () => {
  const run = runWitnessBuildingItsGraph('writes-graph');
  // The fake graph was read: the same verdict the fixture graph gives via --graph.
  assert.equal(run.exitCode, 1);
  assert.equal(run.verdict, 'gaps');
  assert.deepEqual(run.leftovers, []);
});

void test('a failed nx graph build is exit 2 and leaves no temp directory behind', () => {
  const run = runWitnessBuildingItsGraph('fails');
  assert.equal(run.exitCode, 2);
  assert.deepEqual(run.leftovers, []);
});
