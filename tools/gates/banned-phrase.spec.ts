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
import { execFileSync, ExecFileSyncOptions, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { removeFixtureTree } from './fixture-tree';
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

void test('default --mode=file on exempt fixture returns exit 0 (no violations)', () => {
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

void test('--ignore-exemptions on exempt fixture returns exit 1 + violation', () => {
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

void test('--ignore-exemptions BEFORE --mode=file parses correctly', () => {
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

void test('positional path between mode and flag still parses correctly', () => {
  const result = runScanner([FIXTURE_PATH, '--mode=file', '--ignore-exemptions']);
  assert.strictEqual(
    result.exitCode,
    1,
    `positional-in-middle argv must still surface violation; got exit ${result.exitCode}`,
  );
  assert.match(result.stderr, /Banned-phrase violations detected/);
});

void test('PostgreSQL constraint timing syntax is accepted while ordinary prose remains guarded', () => {
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
    removeFixtureTree(fixtureDir);
  }
});

// ---------------------------------------------------------
// (d) Staged mode inside a merge scans only the merge's own lines
// ---------------------------------------------------------

/**
 * A throwaway repository with two branches: `main` carries a file whose
 * comment holds a banned phrase; `feature` diverged before that file existed.
 * Merging `main` into `feature` stages main's file untouched.
 */
function runFixtureGit(root: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: root,
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      // gc.auto / maintenance.auto off: `git commit` otherwise daemonises a gc
      // that keeps writing under .git while the fixture is being removed
      // (INFRA-HIGH-172).
      GIT_CONFIG_COUNT: '4',
      GIT_CONFIG_KEY_0: 'gc.auto',
      GIT_CONFIG_VALUE_0: '0',
      GIT_CONFIG_KEY_1: 'maintenance.auto',
      GIT_CONFIG_VALUE_1: 'false',
      GIT_CONFIG_KEY_2: 'user.name',
      GIT_CONFIG_VALUE_2: 'Aqua Test',
      GIT_CONFIG_KEY_3: 'user.email',
      GIT_CONFIG_VALUE_3: 'aqua-test@example.invalid',
    },
  });
  if (result.status !== 0) {
    throw new Error(`fixture git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/**
 * Run the scanner inside a fixture repository. Git exports GIT_INDEX_FILE /
 * GIT_DIR / GIT_PREFIX to hooks, so under the pre-commit hook the scanner's
 * own git calls would otherwise read the OUTER repository's index instead of
 * the fixture's; every GIT_* variable is dropped for the child.
 */
function runScannerIn(cwd: string, args: readonly string[]): RunResult {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  const opts: ExecFileSyncOptions = {
    cwd,
    encoding: 'utf8',
    env,
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

function createMergeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'aqua-banned-phrase-merge-'));
  runFixtureGit(root, ['init', '--quiet', '--initial-branch=main']);
  writeFileSync(join(root, 'base.ts'), 'export const base = 1;\n', 'utf8');
  runFixtureGit(root, ['add', '--all']);
  runFixtureGit(root, ['commit', '--quiet', '-m', 'base']);
  runFixtureGit(root, ['checkout', '--quiet', '-b', 'feature']);
  writeFileSync(join(root, 'feature.ts'), 'export const feature = 2;\n', 'utf8');
  runFixtureGit(root, ['add', '--all']);
  runFixtureGit(root, ['commit', '--quiet', '-m', 'feature']);
  runFixtureGit(root, ['checkout', '--quiet', 'main']);
  writeFileSync(
    join(root, 'inherited.ts'),
    // The phrase is assembled from fragments so this spec's own source does
    // not trip the gate it tests.
    [
      'export interface Draft {',
      `  id: string; // ${['tempo', 'rary'].join('')} ID for local management`,
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  runFixtureGit(root, ['add', '--all']);
  runFixtureGit(root, ['commit', '--quiet', '-m', 'main carries a banned phrase']);
  runFixtureGit(root, ['checkout', '--quiet', 'feature']);
  runFixtureGit(root, ['merge', '--no-ff', '--no-commit', '--quiet', 'main']);
  return root;
}

void test('staged mode mid-merge does not charge the merge with a phrase the other branch already carried', () => {
  const root = createMergeFixture();
  try {
    // Sanity: the whole-file rule would have refused this merge.
    const wholeFile = runScannerIn(root, ['--mode=file', join(root, 'inherited.ts')]);
    assert.strictEqual(wholeFile.exitCode, 1, 'fixture must carry a banned phrase on main');

    const result = runScannerIn(root, ['--mode=staged']);
    assert.strictEqual(
      result.exitCode,
      0,
      `a file taken wholesale from the other parent is that parent's debt; got exit ${result.exitCode}\n${result.stderr}`,
    );
  } finally {
    removeFixtureTree(root);
  }
});

void test('staged mode mid-merge still refuses a banned phrase the merge itself introduces', () => {
  const root = createMergeFixture();
  try {
    writeFileSync(
      join(root, 'feature.ts'),
      `export const feature = 2; // ${['inte', 'rim'].join('')} value\n`,
      'utf8',
    );
    runFixtureGit(root, ['add', 'feature.ts']);

    const result = runScannerIn(root, ['--mode=staged']);
    assert.strictEqual(result.exitCode, 1, "a line new to both parents is the merge's own");
    assert.match(result.stderr, new RegExp(`feature\\.ts:1:\\d+\\s+"${['inte', 'rim'].join('')}"`));
    assert.doesNotMatch(result.stderr, /inherited\.ts/);
  } finally {
    removeFixtureTree(root);
  }
});
