#!/usr/bin/env ts-node
/**
 * Plan 020 Phase 0.4 — banned-phrase scanner spec tests.
 *
 * Pins the --ignore-exemptions flag behaviour + two-stage argv parser
 * so the verification commands stay deterministic. Pattern mirrors
 * tools/gates/commit-msg-validator.spec.ts (node:test runner, no new
 * dependencies).
 *
 * What this file pins:
 * - default exempt path → no violations (preserves husky/CI behaviour).
 * - --ignore-exemptions flag → exempt path scanned + violations surfaced.
 * - argv parser: flag-before-mode AND flag-after-mode AND positional-
 *   in-the-middle all parse the same way.
 *
 * Smoke-tests the live binary via execFileSync rather than re-importing
 * the module, because main() does its own argv parsing + process.exit;
 * end-to-end exit-code coverage is the load-bearing assertion.
 */

import { strict as assert } from 'node:assert';
import { execFileSync, ExecFileSyncOptions } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const REPO_ROOT = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return process.cwd();
  }
})();

const FIXTURE_PATH = 'tests/invariants/fixtures/plan-020/banned-phrase-positive.md';
const SCANNER = resolve(REPO_ROOT, 'tools/gates/banned-phrase.ts');

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runScanner(args: readonly string[]): RunResult {
  // Capture exit code via `|| true`; spawn synchronously through a
  // shell so we get the exact npx tsx invocation behaviour the
  // verification commands use.
  const opts: ExecFileSyncOptions = {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  try {
    const stdout = execFileSync('npx', ['tsx', SCANNER, ...args], opts) as string;
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      exitCode: typeof e.status === 'number' ? e.status : 1,
      stdout: typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString() ?? ''),
      stderr: typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString() ?? ''),
    };
  }
}

// ---------------------------------------------------------
// (a) Default behaviour — exempt path returns no violations
// ---------------------------------------------------------

test('default --mode=file on exempt fixture returns exit 0 (no violations)', () => {
  const result = runScanner(['--mode=file', FIXTURE_PATH]);
  assert.strictEqual(
    result.exitCode,
    0,
    `expected exit 0 for exempt path under default mode; got ${result.exitCode}`,
  );
  assert.match(result.stdout, /No banned phrases detected/);
});

// ---------------------------------------------------------
// (b) --ignore-exemptions flag — exempt path scanned, violation fires
// ---------------------------------------------------------

test('--ignore-exemptions on exempt fixture returns exit 1 + violation', () => {
  const result = runScanner(['--mode=file', '--ignore-exemptions', FIXTURE_PATH]);
  assert.strictEqual(
    result.exitCode,
    1,
    `expected exit 1 with --ignore-exemptions; got ${result.exitCode}`,
  );
  assert.match(result.stderr, /Banned-phrase violations detected/);
});

// ---------------------------------------------------------
// (c) Argv parser: flag BEFORE mode
// ---------------------------------------------------------

test('--ignore-exemptions BEFORE --mode=file parses correctly', () => {
  const result = runScanner(['--ignore-exemptions', '--mode=file', FIXTURE_PATH]);
  assert.strictEqual(
    result.exitCode,
    1,
    `flag-before-mode argv must still surface violation; got exit ${result.exitCode}`,
  );
  assert.match(result.stderr, /Banned-phrase violations detected/);
});

// ---------------------------------------------------------
// (d) Argv parser: positional path in MIDDLE
// ---------------------------------------------------------

test('positional path between mode and flag still parses correctly', () => {
  const result = runScanner([FIXTURE_PATH, '--mode=file', '--ignore-exemptions']);
  assert.strictEqual(
    result.exitCode,
    1,
    `positional-in-middle argv must still surface violation; got exit ${result.exitCode}`,
  );
  assert.match(result.stderr, /Banned-phrase violations detected/);
});

test('PostgreSQL constraint timing syntax is accepted while ordinary prose remains guarded', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'aqua-banned-phrase-'));
  const fixturePath = join(fixtureDir, 'constraint.sql');

  try {
    writeFileSync(fixturePath, 'DEFERRABLE INITIALLY DEFERRED\n', 'utf8');
    const sqlResult = runScanner(['--mode=file', fixturePath]);
    assert.strictEqual(
      sqlResult.exitCode,
      0,
      `SQL constraint timing syntax must be accepted; got exit ${sqlResult.exitCode}`,
    );

    writeFileSync(fixturePath, ['delivery is ', 'de', 'ferred\n'].join(''), 'utf8');
    const proseResult = runScanner(['--mode=file', fixturePath]);
    assert.strictEqual(
      proseResult.exitCode,
      1,
      `ordinary prose must remain guarded; got exit ${proseResult.exitCode}`,
    );
    assert.match(proseResult.stderr, /Banned-phrase violations detected/);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
