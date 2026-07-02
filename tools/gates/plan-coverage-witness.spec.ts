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
 * Invoke via:
 *   ts-node --project tools/gates/tsconfig.json tools/gates/plan-coverage-witness.spec.ts
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const GATE_DIR = dirname(resolve(__filename));
const REPO_ROOT = resolve(GATE_DIR, '..', '..');
const WITNESS = join(GATE_DIR, 'plan-coverage-witness.ts');
const FIXTURES = join(GATE_DIR, 'fixtures', 'plan-coverage');
const GRAPH = join(FIXTURES, 'nx-graph.json');
const SERVICES_YAML = join(FIXTURES, 'services.yaml');
const FIXTURE_REPO = join(FIXTURES, 'repo');

interface WitnessRun {
  readonly exitCode: number;
  readonly report: {
    verdict: string;
    closure: {
      projects: { name: string; reason: string }[];
      event_consumers: { event_type: string; consumer: string }[];
      migration_couplings: { service: string }[];
    };
    uncovered: { node_id: string; kind: string; why: string }[];
    waived: { node_id: string; reason: string }[];
    unmapped_paths: string[];
    inputs_hash: string;
  };
  readonly stdout: string;
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
  assert.deepEqual(
    consumerNodes.map((n) => n.node_id),
    ['event-consumer:notification-service:BatchHarvested'],
  );
  assert.deepEqual(run.report.closure.event_consumers, [
    {
      event_type: 'BatchHarvested',
      consumer: 'notification-service',
      matching_pattern: 'AQUACULTURE_EVENTS.BatchHarvested.>',
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
  const consumerNodes = run.report.uncovered.filter((n) => n.kind === 'event_consumer');
  assert.equal(consumerNodes.length, 0);
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
      'apps/farm-service/src/database/migrations/1800000000000-add-column.ts',
    ],
    waivers: [],
  });
  assert.equal(withMigration.exitCode, 0);
  assert.equal(withMigration.report.verdict, 'covered');
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
