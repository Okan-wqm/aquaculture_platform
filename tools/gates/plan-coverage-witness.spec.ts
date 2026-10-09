#!/usr/bin/env ts-node
/**
 * Integration tests for tools/gates/plan-coverage-witness.ts.
 *
 * The witness is a single-file CLI (main() runs on load, matching the
 * ripple-tracer design), so the spec exercises it as a subprocess against
 * the fixtures under tools/gates/fixtures/plan-coverage/ — exit codes and
 * the stdout JSON shape ARE the contract that aria_kernel/plan_coverage.py
 * depends on, so that is exactly what gets pinned.
 *
 * ARIA-HIGH-306: a fixture-only spec stayed green for months while the live
 * infrastructure/nats/services.yaml changed format under it and the witness
 * parsed none of it. The live cases below run the witness against the real
 * SSoT and the real event contracts and compare it to an independent read of
 * the same file, so the next format drift turns this spec red.
 *
 * Invoke via:
 *   ts-node --project tools/gates/tsconfig.json tools/gates/plan-coverage-witness.spec.ts
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import { parse as yamlParse } from 'yaml';

const GATE_DIR = dirname(resolve(__filename));
const REPO_ROOT = resolve(GATE_DIR, '..', '..');
const WITNESS = join(GATE_DIR, 'plan-coverage-witness.ts');
const FIXTURES = join(GATE_DIR, 'fixtures', 'plan-coverage');
const GRAPH = join(FIXTURES, 'nx-graph.json');
const SERVICES_YAML = join(FIXTURES, 'services.yaml');
const FIXTURE_REPO = join(FIXTURES, 'repo');
const LIVE_SERVICES_YAML = join(REPO_ROOT, 'infrastructure', 'nats', 'services.yaml');
/** Run against the live SSoT and the real contracts; the nx graph stays the fixture's. */
const LIVE_ARGS = ['--services-yaml', LIVE_SERVICES_YAML, '--repo-root', REPO_ROOT];

// Typed `unknown` so every read of the parsed document is narrowed explicitly.
const parseYaml: (input: string) => unknown = yamlParse;

interface ServicesYamlLedger {
  services: number;
  publish_patterns: number;
  subscribe_patterns: number;
  event_types: number;
}

interface WitnessRun {
  readonly exitCode: number;
  readonly report: {
    verdict: string;
    closure: {
      projects: { name: string; reason: string }[];
      event_consumers: { event_type: string; consumer: string; matching_pattern: string; subject: string }[];
      migration_couplings: { service: string }[];
    };
    uncovered: { node_id: string; kind: string; why: string }[];
    waived: { node_id: string; reason: string }[];
    unmapped_paths: string[];
    ledger: { services_yaml: ServicesYamlLedger | null };
    inputs_hash: string;
  };
  readonly stdout: string;
}

interface LiveService {
  readonly name: string;
  readonly application: string;
  readonly publish: readonly string[];
  readonly subscribe: readonly string[];
}

function stringList(value: unknown): string[] {
  assert.ok(Array.isArray(value), 'services.yaml list expected');
  return value.map((item: unknown) => {
    assert.equal(typeof item, 'string');
    return String(item);
  });
}

/** The live SSoT read independently of the witness — the oracle the live cases compare to. */
function loadLiveServices(): LiveService[] {
  const document = parseYaml(readFileSync(LIVE_SERVICES_YAML, 'utf8'));
  assert.ok(typeof document === 'object' && document !== null && 'services' in document);
  const services: unknown = document.services;
  assert.ok(Array.isArray(services));
  return services.map((entry: unknown): LiveService => {
    assert.ok(typeof entry === 'object' && entry !== null);
    const record = entry as Record<string, unknown>;
    return {
      name: String(record['name']),
      application: String(record['application']),
      publish: stringList(record['publish']),
      subscribe: stringList(record['subscribe']),
    };
  });
}

/** NATS overlap of two subject patterns (`*` = one token, `>` = one or more), the test's own. */
function natsOverlap(a: string, b: string): boolean {
  const left = a.split('.');
  const right = b.split('.');
  for (let index = 0; ; index += 1) {
    const x = left[index];
    const y = right[index];
    if (x === undefined || y === undefined) return x === y;
    if (x === '>' || y === '>') return true;
    if (x !== '*' && y !== '*' && x !== y) return false;
  }
}

function writeServicesYaml(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'plan-coverage-yaml-'));
  const path = join(dir, 'services.yaml');
  writeFileSync(path, source, 'utf8');
  return path;
}

function runWitness(input: object, extraArgs: string[] = []): WitnessRun {
  const dir = mkdtempSync(join(tmpdir(), 'plan-coverage-spec-'));
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
    '--services-yaml',
    SERVICES_YAML,
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

void test('touching a shared lib surfaces its reverse dependents as gaps (exit 1)', () => {
  const run = runWitness({
    schema_version: 1,
    affected_paths: ['libs/farm-shared/src/index.ts'],
    waivers: [],
  });
  assert.equal(run.exitCode, 1);
  assert.equal(run.report.verdict, 'gaps');
  const uncoveredIds = run.report.uncovered.map((n) => n.node_id).sort();
  assert.deepEqual(uncoveredIds, ['project:farm-service', 'project:notification-service']);
});

void test('a dependents-of group waiver covers every reverse dependent (exit 0)', () => {
  const run = runWitness({
    schema_version: 1,
    affected_paths: ['libs/farm-shared/src/index.ts'],
    waivers: [{ node: 'dependents-of:farm-shared', reason: 'type-only change, tsc closure verified' }],
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
  });
  assert.equal(run.exitCode, 1);
  assert.deepEqual(run.report.uncovered.map((n) => n.node_id), ['project:notification-service']);
  assert.deepEqual(run.report.waived.map((n) => n.node_id), ['project:farm-service']);
});

void test('touching an event contract surfaces untouched NATS consumers', () => {
  const run = runWitness({
    schema_version: 1,
    affected_paths: ['libs/event-contracts/src/farm-events.ts'],
    waivers: [{ node: 'dependents-of:event-contracts', reason: 'graph dependents covered by consumer node check' }],
  });
  assert.equal(run.exitCode, 1);
  const consumerNodes = run.report.uncovered.filter((n) => n.kind === 'event_consumer');
  // The yaml names the NATS identity `notification_service`; the node names
  // the nx project its `application:` field maps to. The matching grant is the
  // fixture's one quoted item.
  assert.deepEqual(
    consumerNodes.map((n) => n.node_id),
    ['event-consumer:notification-service:BatchHarvested'],
  );
  assert.deepEqual(run.report.closure.event_consumers, [
    {
      event_type: 'BatchHarvested',
      consumer: 'notification-service',
      matching_pattern: 'events.*.BatchHarvested',
      subject: 'events.*.BatchHarvested',
    },
  ]);
});

void test('a touched consumer project produces no event-consumer node', () => {
  const run = runWitness({
    schema_version: 1,
    affected_paths: [
      'libs/event-contracts/src/farm-events.ts',
      'apps/notification-service/src/handlers/batch-harvested.handler.ts',
    ],
    waivers: [{ node: 'dependents-of:event-contracts', reason: 'covered by direct touch + consumer check' }],
  });
  // The consumer IS recognized (through `application:`), and is covered
  // because the plan touches its nx project — not because nothing matched.
  assert.deepEqual(
    run.report.closure.event_consumers.map((c) => c.consumer),
    ['notification-service'],
  );
  const consumerNodes = run.report.uncovered.filter((n) => n.kind === 'event_consumer');
  assert.equal(consumerNodes.length, 0);
});

void test('quoted and unquoted services.yaml items both parse, and the ledger counts them', () => {
  const run = runWitness({
    schema_version: 1,
    affected_paths: ['libs/event-contracts/src/farm-events.ts'],
    waivers: [],
  });
  assert.deepEqual(run.report.ledger.services_yaml, {
    services: 2,
    publish_patterns: 3,
    subscribe_patterns: 4,
    event_types: 1,
  });
});

void test('subjects come from the declared publish grants; events.*.<T> only when none declares <T>', () => {
  const subscribers = [
    '- name: gateway_service',
    '  application: gateway-api',
    '  description: events-root subscriber',
    '  publish:',
    '  - _INBOX.>',
    '  subscribe:',
    '  - events.>',
    '- name: notification_service',
    '  application: notification-service',
    '  description: telemetry-root subscriber',
    '  publish:',
    '  - _INBOX.>',
    '  subscribe:',
    '  - telemetry.>',
  ];
  const yamlWith = (farmPublish: string): string =>
    [
      'version: 1',
      'services:',
      '- name: farm_service',
      '  application: farm-service',
      '  description: publisher',
      '  publish:',
      `  - ${farmPublish}`,
      '  subscribe:',
      '  - _INBOXFARM_SERVICE.>',
      ...subscribers,
      '',
    ].join('\n');
  const input = {
    schema_version: 1,
    affected_paths: ['libs/event-contracts/src/farm-events.ts'],
    waivers: [],
  };

  // Declared on the telemetry root: only the telemetry subscriber consumes it.
  const declared = runWitness(input, ['--services-yaml', writeServicesYaml(yamlWith('telemetry.*.BatchHarvested'))]);
  assert.deepEqual(declared.report.closure.event_consumers, [
    {
      event_type: 'BatchHarvested',
      consumer: 'notification-service',
      matching_pattern: 'telemetry.>',
      subject: 'telemetry.*.BatchHarvested',
    },
  ]);

  // Declared by no service: the event bus's default root, events.*.<T>.
  const undeclared = runWitness(input, ['--services-yaml', writeServicesYaml(yamlWith('events.*.OtherEvent'))]);
  assert.deepEqual(undeclared.report.closure.event_consumers, [
    {
      event_type: 'BatchHarvested',
      consumer: 'gateway-api',
      matching_pattern: 'events.>',
      subject: 'events.*.BatchHarvested',
    },
  ]);
});

void test('services present with zero parsed patterns is an environment error (exit 2), not an empty closure', () => {
  const emptied = writeServicesYaml(
    [
      'version: 1',
      'services:',
      '- name: farm_service',
      '  application: farm-service',
      '  description: every grant lost',
      '  publish: []',
      '  subscribe: []',
      '',
    ].join('\n'),
  );
  const run = runWitness(
    { schema_version: 1, affected_paths: ['libs/event-contracts/src/farm-events.ts'], waivers: [] },
    ['--services-yaml', emptied],
  );
  assert.equal(run.exitCode, 2);
  assert.equal(run.stdout, '');
});

void test('a services.yaml entry without application: is an environment error (exit 2)', () => {
  const unmapped = writeServicesYaml(
    [
      'version: 1',
      'services:',
      '- name: notification_service',
      '  description: no nx project named',
      '  publish:',
      '  - events.*.NotificationSent',
      '  subscribe:',
      '  - events.*.BatchHarvested',
      '',
    ].join('\n'),
  );
  const run = runWitness(
    { schema_version: 1, affected_paths: ['libs/event-contracts/src/farm-events.ts'], waivers: [] },
    ['--services-yaml', unmapped],
  );
  assert.equal(run.exitCode, 2);
  assert.equal(run.stdout, '');
});

void test('the live services.yaml parses: the ledger counts every publish and subscribe grant', () => {
  const live = loadLiveServices();
  const run = runWitness(
    { schema_version: 1, affected_paths: ['libs/event-contracts/src/notification-events.ts'], waivers: [] },
    LIVE_ARGS,
  );
  assert.ok(run.exitCode === 0 || run.exitCode === 1, `witness exit ${run.exitCode}`);
  const ledger = run.report.ledger.services_yaml;
  assert.ok(ledger !== null);
  assert.equal(ledger.services, live.length);
  assert.equal(ledger.publish_patterns, live.reduce((sum, s) => sum + s.publish.length, 0));
  assert.equal(ledger.subscribe_patterns, live.reduce((sum, s) => sum + s.subscribe.length, 0));
  assert.ok(ledger.subscribe_patterns >= 1);
});

void test('the UserInvited contract yields a node per live events.*.UserInvited subscriber, by nx project', () => {
  const live = loadLiveServices();
  const declared = live.flatMap((s) => s.publish).filter((p) => p.split('.').includes('UserInvited'));
  assert.ok(declared.includes('events.*.UserInvited'), 'auth_service declares events.*.UserInvited');
  const expected = live
    .filter((s) => s.subscribe.some((pattern) => declared.some((subject) => natsOverlap(pattern, subject))))
    .map((s) => `event-consumer:${s.application}:UserInvited`)
    .sort();
  assert.ok(expected.length >= 1, 'the live SSoT grants events.*.UserInvited to at least one subscriber');

  const run = runWitness(
    { schema_version: 1, affected_paths: ['libs/event-contracts/src/notification-events.ts'], waivers: [] },
    LIVE_ARGS,
  );
  const nodes = run.report.uncovered
    .filter((n) => n.kind === 'event_consumer' && n.node_id.endsWith(':UserInvited'))
    .map((n) => n.node_id)
    .sort();
  assert.deepEqual(nodes, expected);
});

void test('a change to auth-events.ts yields event-consumer nodes named by nx project on the live SSoT', () => {
  const live = loadLiveServices();
  const applications = new Set(live.map((s) => s.application));
  const run = runWitness(
    { schema_version: 1, affected_paths: ['libs/event-contracts/src/auth-events.ts'], waivers: [] },
    LIVE_ARGS,
  );
  const consumerNodes = run.report.uncovered.filter((n) => n.kind === 'event_consumer');
  assert.ok(consumerNodes.length >= 1, 'auth events have live subscribers');
  for (const node of consumerNodes) {
    const consumer = node.node_id.split(':')[1] ?? '';
    assert.ok(applications.has(consumer), `${node.node_id} names an application, not a NATS identity`);
  }
});

void test('an entity edit without a migration surfaces migration:<svc>; with one it does not', () => {
  const withoutMigration = runWitness({
    schema_version: 1,
    affected_paths: ['apps/farm-service/src/batch/entities/batch.entity.ts'],
    waivers: [],
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
    affected_paths: ['docs/adr/041-aria-narrow-autonomous-merge-lane.md', '.claude/agents/aria-drafter.md'],
    waivers: [],
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
    options: { max_nodes: 1 },
  });
  assert.equal(run.exitCode, 1);
  assert.deepEqual(run.report.uncovered.map((n) => n.node_id), ['closure:oversized']);
});

void test('output is deterministic — identical inputs produce identical stdout', () => {
  const input = {
    schema_version: 1,
    affected_paths: ['libs/farm-shared/src/index.ts', 'apps/farm-service/src/batch/entities/batch.entity.ts'],
    waivers: [{ node: 'dependents-of:farm-shared', reason: 'verified' }],
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
  const dir = mkdtempSync(join(tmpdir(), 'plan-coverage-spec-'));
  const inputPath = join(dir, 'input.json');
  writeFileSync(
    inputPath,
    JSON.stringify({ schema_version: 1, affected_paths: ['libs/farm-shared/src/index.ts'], waivers: [] }),
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
