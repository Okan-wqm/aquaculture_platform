#!/usr/bin/env node
/**
 * The supervisor makes two judgements, and both are expensive to get wrong:
 * what counts as a casualty, and when to stop trying.
 *
 * Reviving a finished one-shot job would restart the migration runner on
 * every pass. An uncapped restarter turns a crash-loop into a resource fire
 * while hiding the crash behind it. These tests pin those decisions by
 * running the real script against a fake `docker` on PATH — the same way
 * the real one is reached, so argument handling is exercised too.
 *
 * Run: npm run supervisor:test
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// tools/supervisor is an ES module package (the supervisor is loaded by
// systemd through node --experimental-strip-types), so __dirname does not
// exist here.
const SUPERVISOR = join(dirname(fileURLToPath(import.meta.url)), 'runtime-supervisor.ts');

interface Envelope {
  container_count: number;
  supervised_down: string[];
  actions: Array<{ container: string; action: string; detail: string }>;
  problems: Array<{ severity: string; kind: string; detail: string }>;
  disk_used_percent: number;
}

function runWithFakeDocker(params: {
  inspectOutput: string;
  statePath: string;
  startFails?: boolean;
}): { envelope: Envelope; exitCode: number } {
  const bin = mkdtempSync(join(tmpdir(), 'fake-docker-'));
  const startBehaviour = params.startFails
    ? 'echo "Error response from daemon: no such container" >&2; exit 1'
    : 'echo started';
  const script = [
    '#!/bin/sh',
    'case "$1" in',
    '  ps) echo abc123 ;;',
    "  inspect) cat <<'INSPECT_EOF'",
    params.inspectOutput,
    'INSPECT_EOF',
    '  ;;',
    `  start) ${startBehaviour} ;;`,
    'esac',
  ].join('\n');
  writeFileSync(join(bin, 'docker'), `${script}\n`, { mode: 0o755 });

  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execFileSync(process.execPath, ['--experimental-strip-types', SUPERVISOR], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        SUPERVISOR_STATE_PATH: params.statePath,
        SUPERVISOR_TEXTFILE_PATH: join(bin, 'metrics.prom'),
      },
    });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    exitCode = failure.status ?? 1;
    stdout = failure.stdout ?? '';
  }
  return { envelope: JSON.parse(stdout) as Envelope, exitCode };
}

function freshStatePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'sup-state-')), 'state.json');
}

void test('revives a container Docker itself says should be running', () => {
  const { envelope } = runWithFakeDocker({
    statePath: freshStatePath(),
    inspectOutput: [
      '/aqua-farm\ttrue\t0\tunless-stopped\t0001-01-01T00:00:00Z',
      '/aqua-provisioner\tfalse\t1\tunless-stopped\t2026-07-31T11:51:26Z',
    ].join('\n'),
  });

  assert.equal(envelope.actions.length, 1);
  assert.equal(envelope.actions[0]?.container, 'aqua-provisioner');
  assert.equal(envelope.actions[0]?.action, 'restarted');
});

void test('leaves a finished one-shot job alone', () => {
  // db-migrate exits 0 with restart:no once its work is done, and the
  // walg integration containers are killed on purpose. Neither is a
  // casualty; treating them as one would restart a migration runner every
  // two minutes.
  const { envelope, exitCode } = runWithFakeDocker({
    statePath: freshStatePath(),
    inspectOutput: [
      '/aqua-db-migrate\tfalse\t0\tno\t2026-07-15T02:40:09Z',
      '/aqua-walg-it-target\tfalse\t137\tno\t2026-08-05T21:42:18Z',
      '/aqua-farm\ttrue\t0\tunless-stopped\t0001-01-01T00:00:00Z',
    ].join('\n'),
  });

  assert.deepEqual(envelope.actions, []);
  assert.deepEqual(envelope.supervised_down, []);
  assert.equal(envelope.problems.filter((p) => p.kind === 'container_down').length, 0);
  assert.notEqual(exitCode, 1);
});

void test('stops restarting after the cap and asks for a human', () => {
  const statePath = freshStatePath();
  const down = '/aqua-crashloop\tfalse\t1\talways\t2026-08-06T05:00:00Z';

  for (let pass = 0; pass < 3; pass += 1) {
    const { envelope } = runWithFakeDocker({ statePath, inspectOutput: down });
    assert.equal(envelope.actions[0]?.action, 'restarted');
  }

  const fourth = runWithFakeDocker({ statePath, inspectOutput: down });

  assert.equal(fourth.envelope.actions[0]?.action, 'restart_capped');
  assert.match(String(fourth.envelope.actions[0]?.detail), /human/);
  // Capped must stay loud: giving up quietly is the failure mode this
  // whole process exists to end.
  assert.ok(fourth.envelope.problems.some((p) => p.kind === 'container_down'));
  assert.equal(fourth.exitCode, 3);
});

void test('reports a failed restart instead of swallowing it', () => {
  const { envelope, exitCode } = runWithFakeDocker({
    statePath: freshStatePath(),
    startFails: true,
    inspectOutput: '/aqua-gone\tfalse\t1\tunless-stopped\t2026-08-06T05:00:00Z',
  });

  assert.equal(envelope.actions[0]?.action, 'restart_failed');
  assert.ok(envelope.problems.some((p) => p.severity === 'critical'));
  assert.equal(exitCode, 3);
});

void test('remembers restarts across passes so the cap is real', () => {
  const statePath = freshStatePath();
  runWithFakeDocker({
    statePath,
    inspectOutput: '/aqua-crashloop\tfalse\t1\talways\t2026-08-06T05:00:00Z',
  });

  const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
    restarts: Record<string, number[]>;
  };

  assert.equal(state.restarts['aqua-crashloop']?.length, 1);
});
