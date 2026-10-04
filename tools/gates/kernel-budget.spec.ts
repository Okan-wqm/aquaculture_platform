#!/usr/bin/env ts-node
/**
 * Integration tests for tools/gates/kernel-budget.ts (ADR-0025).
 *
 * The gate is a CLI whose contract is its exit code and its report, so each
 * case builds a throwaway git repository with a kernel tree, a budget policy
 * and a first-parent history of merged changes, then runs the gate against
 * it as a subprocess. Nothing reads this repository's own history: the
 * numbers below are the fixtures' numbers.
 *
 * Invoke via:
 *   ts-node --project tools/gates/tsconfig.json tools/gates/kernel-budget.spec.ts
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const GATE_DIR = dirname(resolve(__filename));
const REPO_ROOT = resolve(GATE_DIR, '..', '..');
const GATE = join(GATE_DIR, 'kernel-budget.ts');

const KERNEL = 'aria-kernel/aria_kernel';
const POLICY_PATH = 'docs/aria/policy/kernel-budget.json';
const ADR_PATH =
  'docs/recommendations/architectural-arbiter/2026-10-04-adr-0025-kernel-budget-measured-base.md';
/**
 * HERMETIC env: every GIT_* variable stripped, for the fixture's git calls AND
 * for the gate subprocess. The pre-commit hook runs this spec, and git exports
 * GIT_DIR / GIT_INDEX_FILE to hooks; an inherited GIT_DIR overrides
 * `-C <fixture>` and points the fixture's `init` and `config` at the host
 * repository (its first hook run rewrote the shared checkout's user.* and
 * commit.gpgsign). A fixture never inherits the ambient git context.
 */
const HERMETIC_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);

const RAISE_ADR_PATH =
  'docs/recommendations/architectural-arbiter/2026-10-05-adr-0027-raise-kernel-budget.md';

interface Violation {
  readonly rule: string;
  readonly message: string;
}

interface Report {
  readonly verdict: 'pass' | 'fail';
  readonly violations: Violation[];
  readonly merged: {
    changes: number;
    added: number;
    deleted: number;
    credit: number;
    measure: number;
    modules: number;
  };
  readonly change: {
    added: number;
    deleted: number;
    charge: number;
    modules: number;
    predating_entry: number | null;
  };
  readonly projected: { lines: number; modules: number };
  readonly stale_predating: number[];
  readonly merged_over_cap: { pr: number | null; added: number }[];
}

interface GateRun {
  readonly exitCode: number;
  readonly report: Report | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface PredatingEntry {
  number: number;
  branch: string;
  head_sha: string;
  kernel_added: number;
  kernel_deleted: number;
  module_delta: number;
}

interface PolicyShape {
  ceilingLines: number;
  ceilingModules: number;
  perChangeLines: number;
  perChangeModules: number;
  predating: PredatingEntry[];
  adrRefs?: string[];
}

class FixtureRepo {
  readonly dir: string;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'kernel-budget-spec-'));
    this.git('init', '-q', '-b', 'main');
    this.git('config', 'user.email', 'spec@example.invalid');
    this.git('config', 'user.name', 'kernel-budget spec');
    this.git('config', 'commit.gpgsign', 'false');
  }

  git(...args: string[]): string {
    return execFileSync('git', ['-C', this.dir, ...args], {
      encoding: 'utf8',
      env: HERMETIC_ENV,
    }).trim();
  }

  write(path: string, content: string): void {
    const absolute = join(this.dir, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }

  remove(path: string): void {
    rmSync(join(this.dir, path));
  }

  commit(message: string): string {
    this.git('add', '-A');
    this.git('commit', '-q', '--allow-empty', '-m', message);
    return this.git('rev-parse', 'HEAD');
  }

  /** Lands `branch` on main the way GitHub does: a --no-ff merge commit. */
  mergeToMain(branch: string, pr: number): string {
    this.git('checkout', '-q', 'main');
    this.git(
      'merge',
      '-q',
      '--no-ff',
      '-m',
      `Merge pull request #${pr} from owner/${branch}`,
      branch,
    );
    return this.git('rev-parse', 'HEAD');
  }

  branch(name: string, from = 'main'): void {
    this.git('checkout', '-q', '-b', name, from);
  }

  writePolicy(baseSha: string, shape: PolicyShape): void {
    this.write(POLICY_PATH, `${JSON.stringify(policyDocument(baseSha, shape))}\n`);
  }
}

function policyDocument(baseSha: string, shape: PolicyShape): object {
  return {
    $schema: 'aria/kernel-budget/v1',
    schema_version: 1,
    status: 'proposed',
    adr_refs: shape.adrRefs ?? [ADR_PATH],
    base_sha: baseSha,
    base_exception: {
      pr: 1,
      branch: 'k1',
      merge_sha: baseSha,
      kernel_added: 10,
      kernel_deleted: 0,
      reason: 'pre-program change; the base is its merge commit, so it is outside the measure',
    },
    ceiling: { kernel_lines: shape.ceilingLines, module_net: shape.ceilingModules },
    per_pr_max: { kernel_lines: shape.perChangeLines, module_net: shape.perChangeModules },
    measurement: {
      main_sha: baseSha,
      measured_on: '2026-10-04',
      merged_kernel_lines: 0,
      open_predating_kernel_lines: 0,
      rev3_min_estimate_kernel_lines: 0,
    },
    predating_prs: shape.predating,
  };
}

function lines(count: number, tag: string): string {
  return Array.from({ length: count }, (_, index) => `${tag}_${index} = ${index}\n`).join('');
}

const DEFAULT_SHAPE: PolicyShape = {
  ceilingLines: 100,
  ceilingModules: 0,
  perChangeLines: 30,
  perChangeModules: 0,
  predating: [],
};

/**
 * A repository whose main carries: the base (K1 analog: one kernel module of
 * `seedLines` lines), then the policy + ADR commit. Returns the base SHA.
 */
function seededRepo(
  shape: Partial<PolicyShape> = {},
  seedLines = 10,
): { repo: FixtureRepo; base: string } {
  const repo = new FixtureRepo();
  repo.write(`${KERNEL}/core.py`, lines(seedLines, 'seed'));
  repo.write('README.md', 'fixture\n');
  const base = repo.commit('k1: seed kernel');
  repo.writePolicy(base, { ...DEFAULT_SHAPE, ...shape });
  repo.write(ADR_PATH, '# ADR-0025 fixture\n');
  repo.commit('adr-0025: kernel budget policy');
  return { repo, base };
}

/** Merges a change adding `added` kernel lines to core.py as PR `pr`. */
function landKernelLines(repo: FixtureRepo, pr: number, added: number): void {
  const branch = `merged-${pr}`;
  repo.branch(branch);
  repo.write(`${KERNEL}/core.py`, readFile(repo, `${KERNEL}/core.py`) + lines(added, `m${pr}`));
  repo.commit(`change ${pr}`);
  repo.mergeToMain(branch, pr);
}

function readFile(repo: FixtureRepo, path: string): string {
  return repo.git('show', `HEAD:${path}`) + '\n';
}

function runGate(repo: FixtureRepo, args: string[], extraEnv: NodeJS.ProcessEnv = {}): GateRun {
  const argv = [
    'ts-node',
    '--project',
    join(REPO_ROOT, 'tools', 'gates', 'tsconfig.json'),
    GATE,
    '--repo-root',
    repo.dir,
    '--base-ref',
    'main',
    '--json',
    ...args,
  ];
  try {
    const stdout = execFileSync('npx', argv, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...HERMETIC_ENV, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, report: JSON.parse(stdout) as Report, stdout, stderr: '' };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    const stdout = failed.stdout ?? '';
    return {
      exitCode: failed.status ?? -1,
      report: stdout.trim().startsWith('{') ? (JSON.parse(stdout) as Report) : null,
      stdout,
      stderr: failed.stderr ?? '',
    };
  }
}

function rules(run: GateRun): string[] {
  return (run.report?.violations ?? []).map((violation) => violation.rule).sort();
}

void test('under budget: merged and proposed kernel lines inside both limits pass (exit 0)', () => {
  const { repo } = seededRepo();
  landKernelLines(repo, 11, 20);
  repo.branch('feat/small');
  repo.write(`${KERNEL}/core.py`, readFile(repo, `${KERNEL}/core.py`) + lines(25, 'pr'));
  repo.commit('small change');

  const run = runGate(repo, [
    '--head',
    'feat/small',
    '--pr-number',
    '12',
    '--head-ref',
    'feat/small',
  ]);
  assert.equal(run.exitCode, 0, run.stderr + run.stdout);
  assert.equal(run.report?.verdict, 'pass');
  assert.equal(run.report?.merged.measure, 20);
  assert.equal(run.report?.merged.changes, 1);
  assert.equal(run.report?.change.added, 25);
  assert.equal(run.report?.projected.lines, 45);
  assert.deepEqual(run.report?.violations, []);
});

void test('cumulative overrun: merged plus this change past the ceiling fails with the numbers', () => {
  const { repo } = seededRepo({ ceilingLines: 40 });
  landKernelLines(repo, 11, 20);
  repo.branch('feat/over');
  repo.write(`${KERNEL}/core.py`, readFile(repo, `${KERNEL}/core.py`) + lines(25, 'pr'));
  repo.commit('pushes past the ceiling');

  const run = runGate(repo, [
    '--head',
    'feat/over',
    '--pr-number',
    '12',
    '--head-ref',
    'feat/over',
  ]);
  assert.equal(run.exitCode, 1);
  assert.deepEqual(rules(run), ['cumulative_lines']);
  const message = run.report?.violations[0]?.message ?? '';
  assert.match(message, /45/);
  assert.match(message, /40/);
  assert.match(message, /ADR/);
  assert.match(run.stderr, /cumulative_lines/);
});

void test('per-change overrun: more than the per-PR cap fails even far below the ceiling', () => {
  const { repo } = seededRepo({ ceilingLines: 1000 });
  repo.branch('feat/wide');
  repo.write(`${KERNEL}/core.py`, readFile(repo, `${KERNEL}/core.py`) + lines(35, 'pr'));
  repo.commit('wide change');

  const run = runGate(repo, [
    '--head',
    'feat/wide',
    '--pr-number',
    '12',
    '--head-ref',
    'feat/wide',
  ]);
  assert.equal(run.exitCode, 1);
  assert.deepEqual(rules(run), ['per_change_lines']);
  assert.match(run.report?.violations[0]?.message ?? '', /35.*30|30.*35/);
});

void test('a named predating PR may carry its measured size and module delta, and nothing more', () => {
  const entry: PredatingEntry = {
    number: 21,
    branch: 'feat/big',
    head_sha: '0'.repeat(40),
    kernel_added: 35,
    kernel_deleted: 0,
    module_delta: 1,
  };
  const { repo } = seededRepo({ ceilingLines: 1000, ceilingModules: 1, predating: [entry] });
  repo.branch('feat/big');
  repo.write(`${KERNEL}/core.py`, readFile(repo, `${KERNEL}/core.py`) + lines(30, 'pr'));
  repo.write(`${KERNEL}/extra.py`, lines(5, 'extra'));
  repo.commit('predating change');

  const named = runGate(repo, [
    '--head',
    'feat/big',
    '--pr-number',
    '21',
    '--head-ref',
    'feat/big',
  ]);
  assert.equal(named.exitCode, 0, named.stderr + named.stdout);
  assert.equal(named.report?.change.predating_entry, 21);
  assert.equal(named.report?.change.added, 35);
  assert.equal(named.report?.change.modules, 1);

  // The same diff under another PR number is not the named PR.
  const unnamed = runGate(repo, [
    '--head',
    'feat/big',
    '--pr-number',
    '22',
    '--head-ref',
    'feat/big',
  ]);
  assert.equal(unnamed.exitCode, 1);
  assert.deepEqual(rules(unnamed), ['per_change_lines', 'per_change_modules']);

  // A matching number on another branch is not the named PR either.
  const otherBranch = runGate(repo, [
    '--head',
    'feat/big',
    '--pr-number',
    '21',
    '--head-ref',
    'feat/other',
  ]);
  assert.equal(otherBranch.exitCode, 1);
  assert.equal(otherBranch.report?.change.predating_entry, null);

  // The named PR grown past its measured size loses the allowance for the excess.
  repo.write(`${KERNEL}/core.py`, readFile(repo, `${KERNEL}/core.py`) + lines(1, 'grow'));
  repo.commit('grows past its measured size');
  const grown = runGate(repo, [
    '--head',
    'feat/big',
    '--pr-number',
    '21',
    '--head-ref',
    'feat/big',
  ]);
  assert.equal(grown.exitCode, 1);
  assert.deepEqual(rules(grown), ['per_change_lines']);
  assert.match(grown.report?.violations[0]?.message ?? '', /#21/);
});

void test('test files under the kernel package are excluded from lines and modules', () => {
  const { repo } = seededRepo();
  repo.branch('feat/tests-only');
  repo.write(`${KERNEL}/tests/test_core.py`, lines(100, 't1'));
  repo.write(`${KERNEL}/test_inline.py`, lines(100, 't2'));
  repo.write(`${KERNEL}/core_test.py`, lines(100, 't3'));
  repo.write(`${KERNEL}/conftest.py`, lines(100, 't4'));
  repo.write('aria-kernel/tests/test_outside.py', lines(100, 't5'));
  repo.commit('tests only');

  const run = runGate(repo, [
    '--head',
    'feat/tests-only',
    '--pr-number',
    '12',
    '--head-ref',
    'feat/tests-only',
  ]);
  assert.equal(run.exitCode, 0, run.stderr + run.stdout);
  assert.equal(run.report?.change.added, 0);
  assert.equal(run.report?.change.modules, 0);
});

void test('deletions are credited only once they are merged', () => {
  const { repo } = seededRepo({ ceilingLines: 50 }, 60);
  landKernelLines(repo, 11, 45);

  // A deletion sitting on an unmerged branch.
  repo.branch('feat/delete');
  repo.write(
    `${KERNEL}/core.py`,
    readFile(repo, `${KERNEL}/core.py`).split('\n').slice(40).join('\n'),
  );
  repo.commit('delete 40 seed lines');

  repo.branch('feat/add', 'main');
  repo.write(`${KERNEL}/extra_lines.txt`, lines(10, 'pr'));
  repo.commit('adds ten kernel lines');

  const before = runGate(repo, [
    '--head',
    'feat/add',
    '--pr-number',
    '13',
    '--head-ref',
    'feat/add',
  ]);
  assert.equal(before.exitCode, 1);
  assert.equal(before.report?.merged.measure, 45);
  assert.equal(before.report?.merged.credit, 0);
  assert.deepEqual(rules(before), ['cumulative_lines']);

  repo.mergeToMain('feat/delete', 14);
  const after = runGate(repo, [
    '--head',
    'feat/add',
    '--pr-number',
    '13',
    '--head-ref',
    'feat/add',
  ]);
  assert.equal(after.exitCode, 0, after.stderr + after.stdout);
  assert.equal(after.report?.merged.credit, 40);
  assert.equal(after.report?.merged.measure, 5);
  assert.equal(after.report?.projected.lines, 15);
});

void test('a rewrite earns no credit: deletions offset only the lines they exceed', () => {
  const { repo } = seededRepo({ ceilingLines: 1000, perChangeLines: 1000 }, 60);
  repo.branch('feat/rewrite');
  // 60 lines out, 60 lines in: gross 60 added, 60 deleted, credit 0.
  repo.write(`${KERNEL}/core.py`, lines(60, 'rewritten'));
  repo.commit('rewrite');
  repo.mergeToMain('feat/rewrite', 15);

  const run = runGate(repo, ['--head', 'main']);
  assert.equal(run.exitCode, 0, run.stderr + run.stdout);
  assert.equal(run.report?.merged.added, 60);
  assert.equal(run.report?.merged.deleted, 60);
  assert.equal(run.report?.merged.credit, 0);
  assert.equal(run.report?.merged.measure, 60);
});

void test('a new kernel module fails the per-change and cumulative module limits', () => {
  const { repo } = seededRepo({ ceilingLines: 1000 });
  repo.branch('feat/module');
  repo.write(`${KERNEL}/new_module.py`, lines(5, 'mod'));
  repo.commit('new module');

  const run = runGate(repo, [
    '--head',
    'feat/module',
    '--pr-number',
    '12',
    '--head-ref',
    'feat/module',
  ]);
  assert.equal(run.exitCode, 1);
  assert.deepEqual(rules(run), ['cumulative_modules', 'per_change_modules']);
});

void test('raising the ceiling without an ADR in the same diff fails; with one it passes', () => {
  const { repo, base } = seededRepo({ ceilingLines: 20 });
  repo.branch('feat/raise');
  repo.write(`${KERNEL}/core.py`, readFile(repo, `${KERNEL}/core.py`) + lines(25, 'pr'));
  repo.writePolicy(base, { ...DEFAULT_SHAPE, ceilingLines: 60 });
  repo.commit('raises its own ceiling');

  const without = runGate(repo, [
    '--head',
    'feat/raise',
    '--pr-number',
    '12',
    '--head-ref',
    'feat/raise',
  ]);
  assert.equal(without.exitCode, 1);
  // An unauthorised policy edit is ignored: the limits are main's, so the
  // overrun it tried to cover is reported next to the edit itself.
  assert.deepEqual(rules(without), ['cumulative_lines', 'policy_change_without_adr']);

  repo.writePolicy(base, {
    ...DEFAULT_SHAPE,
    ceilingLines: 60,
    adrRefs: [ADR_PATH, RAISE_ADR_PATH],
  });
  repo.write(RAISE_ADR_PATH, '# ADR-0027 raise fixture\n');
  repo.commit('adds the ADR that raises it');
  const withAdr = runGate(repo, [
    '--head',
    'feat/raise',
    '--pr-number',
    '12',
    '--head-ref',
    'feat/raise',
  ]);
  assert.equal(withAdr.exitCode, 0, withAdr.stderr + withAdr.stdout);
});

void test('removing a predating entry tightens the policy and needs no ADR', () => {
  const entry: PredatingEntry = {
    number: 21,
    branch: 'feat/big',
    head_sha: '0'.repeat(40),
    kernel_added: 35,
    kernel_deleted: 0,
    module_delta: 0,
  };
  const { repo, base } = seededRepo({ predating: [entry] });
  repo.branch('chore/drop-entry');
  repo.writePolicy(base, { ...DEFAULT_SHAPE, predating: [] });
  repo.commit('drop the entry of a closed PR');

  const run = runGate(repo, ['--head', 'chore/drop-entry']);
  assert.equal(run.exitCode, 0, run.stderr + run.stdout);
});

void test('a named entry whose PR merged is reported stale and grants nothing', () => {
  const entry: PredatingEntry = {
    number: 11,
    branch: 'merged-11',
    head_sha: '0'.repeat(40),
    kernel_added: 20,
    kernel_deleted: 0,
    module_delta: 0,
  };
  const { repo } = seededRepo({ predating: [entry] });
  landKernelLines(repo, 11, 20);

  const run = runGate(repo, ['--head', 'main']);
  assert.equal(run.exitCode, 0, run.stderr + run.stdout);
  assert.deepEqual(run.report?.stale_predating, [11]);
});

void test('CI shape: the synthetic PR merge commit measures exactly the PR', () => {
  const { repo } = seededRepo();
  landKernelLines(repo, 11, 20);
  repo.branch('feat/ci');
  repo.write(`${KERNEL}/data/ci_table.json`, lines(25, 'pr'));
  repo.commit('ci change');
  // main moves on after the branch was cut.
  landKernelLines(repo, 16, 5);
  repo.git('checkout', '-q', '--detach', 'main');
  repo.git('merge', '-q', '--no-ff', '-m', 'Merge feat/ci into main', 'feat/ci');
  const synthetic = repo.git('rev-parse', 'HEAD');

  const run = runGate(repo, ['--head', synthetic, '--pr-number', '12', '--head-ref', 'feat/ci']);
  assert.equal(run.exitCode, 0, run.stderr + run.stdout);
  assert.equal(run.report?.merged.measure, 25);
  assert.equal(run.report?.change.added, 25);
  assert.equal(run.report?.projected.lines, 50);
});

void test('main over its ceiling fails the push run', () => {
  const { repo } = seededRepo({ ceilingLines: 15, perChangeLines: 1000 });
  landKernelLines(repo, 11, 20);

  const run = runGate(repo, ['--head', 'main']);
  assert.equal(run.exitCode, 1);
  assert.deepEqual(rules(run), ['cumulative_lines']);
});

void test('a merged change over the per-change cap is reported, not failed', () => {
  const { repo } = seededRepo({ ceilingLines: 1000 });
  landKernelLines(repo, 11, 50);

  const run = runGate(repo, ['--head', 'main']);
  assert.equal(run.exitCode, 0, run.stderr + run.stdout);
  assert.deepEqual(run.report?.merged_over_cap, [{ pr: 11, added: 50 }]);
});

void test('a base the head does not descend from is an environment error (exit 2)', () => {
  const { repo } = seededRepo();
  const orphanBase = 'f'.repeat(40);
  const policy = JSON.parse(readFile(repo, POLICY_PATH)) as { base_sha: string };
  policy.base_sha = orphanBase;
  repo.write(POLICY_PATH, `${JSON.stringify(policy)}\n`);
  repo.commit('corrupt base');

  const run = runGate(repo, ['--head', 'main']);
  assert.equal(run.exitCode, 2);
  assert.match(run.stderr, /base_sha/);
});

void test('an unknown policy key fails closed (exit 2)', () => {
  const { repo } = seededRepo();
  const policy = JSON.parse(readFile(repo, POLICY_PATH)) as Record<string, unknown>;
  policy.exempt_everything = true;
  repo.write(POLICY_PATH, `${JSON.stringify(policy)}\n`);
  repo.commit('unknown key');

  const run = runGate(repo, ['--head', 'main']);
  assert.equal(run.exitCode, 2);
  assert.match(run.stderr, /exempt_everything/);
});

void test('an inherited GIT_DIR (a git hook) does not redirect the gate away from --repo-root', () => {
  const { repo } = seededRepo();
  landKernelLines(repo, 11, 20);
  const decoy = seededRepo().repo;
  landKernelLines(decoy, 31, 7);

  const run = runGate(repo, ['--head', 'main'], {
    GIT_DIR: join(decoy.dir, '.git'),
    GIT_INDEX_FILE: join(decoy.dir, '.git', 'index'),
  });
  assert.equal(run.exitCode, 0, run.stderr + run.stdout);
  assert.equal(run.report?.merged.measure, 20);
});
