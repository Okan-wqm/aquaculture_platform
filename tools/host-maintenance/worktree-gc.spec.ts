#!/usr/bin/env node
/**
 * The collector deletes directories on the production host, so every
 * decision it makes to KEEP something is pinned here against real git
 * repositories: a bare "origin", a clone acting as the main checkout, and
 * worktrees in each state the droplet actually has. The script is run as a
 * child process exactly as systemd runs it, so argument and env handling,
 * exit codes and the JSON line are exercised too.
 *
 * "Old" worktrees are made old the way git would see them: the reflog entry
 * is written under a backdated GIT_COMMITTER_DATE and the index mtime is set
 * back. Nothing in the tool is told to pretend.
 *
 * Run: npm run tools:test
 */
import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BUILTIN_PROTECTED,
  classifyLocation,
  heldWorktrees,
  parseWorktreeList,
  readConfig,
  type WorktreeReport,
} from './worktree-gc.ts';

const TOOL = join(dirname(fileURLToPath(import.meta.url)), 'worktree-gc.ts');
const OLD_SECONDS = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
const HOOK_GIT_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
];

interface Fixture {
  tmp: string;
  repo: string;
  roots: string;
  procRoot: string;
}

interface Summary {
  fatal: { kind: string } | null;
  prune: string;
  counts: Record<string, number>;
  bytes_reclaimed_estimate: number | null;
  worktrees: WorktreeReport[];
}

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // The suite also runs from git hooks, which export GIT_DIR and friends.
  const inherited = Object.entries(process.env).filter(([key]) => !HOOK_GIT_VARS.includes(key));
  return {
    ...Object.fromEntries(inherited),
    GIT_AUTHOR_NAME: 'gc-test',
    GIT_AUTHOR_EMAIL: 'gc-test@example.invalid',
    GIT_COMMITTER_NAME: 'gc-test',
    GIT_COMMITTER_EMAIL: 'gc-test@example.invalid',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    ...extra,
  };
}

function git(args: string[], extra: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    env: baseEnv(extra),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const OLD_ENV = {
  GIT_COMMITTER_DATE: `@${OLD_SECONDS} +0000`,
  GIT_AUTHOR_DATE: `@${OLD_SECONDS} +0000`,
};

function fixture(): Fixture {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'wtgc-')));
  const origin = join(tmp, 'origin.git');
  const seed = join(tmp, 'seed');
  const repo = join(tmp, 'repo');
  git(['init', '--quiet', '--bare', '-b', 'main', origin]);
  git(['clone', '--quiet', origin, seed]);
  writeFileSync(join(seed, 'README.md'), 'seed\n');
  writeFileSync(join(seed, '.gitignore'), 'node_modules\n.state/\n');
  git(['-C', seed, 'add', '.']);
  git(['-C', seed, 'commit', '--quiet', '-m', 'seed'], OLD_ENV);
  git(['-C', seed, 'push', '--quiet', 'origin', 'HEAD:main']);
  git(['clone', '--quiet', origin, repo]);

  const roots = join(tmp, 'wt');
  mkdirSync(roots);
  // A fake /proc with one process whose cwd is "/" and nothing open: a
  // readable process table that holds none of the fixture's worktrees.
  const procRoot = join(tmp, 'proc');
  mkdirSync(join(procRoot, '1', 'fd'), { recursive: true });
  symlinkSync('/', join(procRoot, '1', 'cwd'));
  writeFileSync(join(procRoot, '1', 'maps'), '');
  return { tmp, repo, roots, procRoot };
}

function gitDirOf(worktree: string): string {
  const match = /^gitdir: (.+)$/m.exec(readFileSync(join(worktree, '.git'), 'utf8'));
  assert.ok(match?.[1]);
  return resolve(worktree, match[1].trim());
}

function backdate(worktree: string): void {
  utimesSync(join(gitDirOf(worktree), 'index'), OLD_SECONDS, OLD_SECONDS);
}

function addWorktree(
  fx: Fixture,
  name: string,
  opts: { old?: boolean; under?: string } = {},
): string {
  const path = join(opts.under ?? fx.roots, name);
  const old = opts.old ?? true;
  git(
    ['-C', fx.repo, 'worktree', 'add', '--quiet', '-b', name, path, 'origin/main'],
    old ? OLD_ENV : {},
  );
  if (old) backdate(path);
  return path;
}

function runGc(
  fx: Fixture,
  args: string[] = [],
  env: Record<string, string | null> = {},
): { summary: Summary; exitCode: number } {
  const merged: Record<string, string | null> = {
    AQUA_REPO: fx.repo,
    WORKTREE_GC_ROOTS: fx.roots,
    WORKTREE_GC_PROC_ROOT: fx.procRoot,
    ...env,
  };
  const unset = new Set(Object.keys(merged).filter((key) => merged[key] === null));
  const childEnv: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries({ ...baseEnv(), ...merged }).filter(
      (entry): entry is [string, string] => !unset.has(entry[0]) && typeof entry[1] === 'string',
    ),
  );
  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execFileSync(process.execPath, ['--experimental-strip-types', TOOL, ...args], {
      encoding: 'utf8',
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    exitCode = failure.status ?? 1;
    stdout = failure.stdout ?? '';
  }
  return { summary: JSON.parse(stdout) as Summary, exitCode };
}

function reportFor(summary: Summary, path: string): WorktreeReport {
  const report = summary.worktrees.find((w) => w.path === path);
  assert.ok(report, `no report for ${path}`);
  return report;
}

function isRoot(): boolean {
  return typeof process.geteuid === 'function' && process.geteuid() === 0;
}

void test('removes a merged, clean, idle worktree and keeps its branch and the main checkout', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'merged-clean');
  // node_modules on the droplet is often a symlink into the main checkout.
  // Removal must unlink it, never follow it.
  const shared = join(fx.tmp, 'shared-modules');
  mkdirSync(shared);
  writeFileSync(join(shared, 'keep.txt'), 'not ours\n');
  symlinkSync(shared, join(wt, 'node_modules'));

  const { summary, exitCode } = runGc(fx);

  assert.equal(exitCode, 0);
  assert.equal(reportFor(summary, wt).decision, 'removed');
  assert.equal(existsSync(wt), false);
  assert.equal(existsSync(join(shared, 'keep.txt')), true);
  assert.equal(reportFor(summary, fx.repo).reason, 'main_checkout');
  assert.ok(existsSync(join(fx.repo, 'README.md')));
  git(['-C', fx.repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/merged-clean']);
  assert.equal(summary.prune, 'ok');
  assert.equal(typeof summary.bytes_reclaimed_estimate, 'number');
});

void test('keeps merged worktrees that carry uncommitted or untracked work', () => {
  const fx = fixture();
  const tracked = addWorktree(fx, 'dirty-tracked');
  writeFileSync(join(tracked, 'README.md'), 'unsaved edit\n');
  const untracked = addWorktree(fx, 'dirty-untracked');
  writeFileSync(join(untracked, 'notes.txt'), 'scratch\n');

  const { summary, exitCode } = runGc(fx);

  assert.equal(exitCode, 0);
  for (const wt of [tracked, untracked]) {
    assert.equal(reportFor(summary, wt).decision, 'kept');
    assert.equal(reportFor(summary, wt).reason, 'merged_but_dirty');
    assert.ok(existsSync(wt));
  }
  assert.equal(summary.counts.kept_merged_but_dirty, 2);
});

void test('keeps a worktree whose HEAD is not in origin/main', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'unmerged');
  writeFileSync(join(wt, 'feature.txt'), 'work\n');
  git(['-C', wt, 'add', 'feature.txt']);
  git(['-C', wt, 'commit', '--quiet', '-m', 'feature'], OLD_ENV);
  backdate(wt);

  const { summary } = runGc(fx);

  assert.equal(reportFor(summary, wt).reason, 'unmerged');
  assert.ok(existsSync(wt));
});

void test('keeps a merged, clean worktree inside the grace period', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'fresh', { old: false });

  const { summary } = runGc(fx);

  assert.equal(reportFor(summary, wt).reason, 'recently_active');
  assert.ok(existsSync(wt));
});

void test('keeps a locked worktree', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'locked');
  git(['-C', fx.repo, 'worktree', 'lock', wt]);

  const { summary } = runGc(fx);

  assert.equal(reportFor(summary, wt).reason, 'locked');
  assert.ok(existsSync(wt));
});

void test('keeps a worktree a live process has as its cwd', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'in-use');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: wt,
    stdio: 'ignore',
  });
  try {
    // Real /proc: the process table the unit will read on the droplet.
    const { summary } = runGc(fx, [], { WORKTREE_GC_PROC_ROOT: null });
    const report = reportFor(summary, wt);
    assert.equal(report.decision, 'kept');
    // As non-root (CI runner) other users' processes are unreadable, and an
    // unreadable process table keeps everything. Both are "kept".
    if (isRoot()) assert.equal(report.reason, 'process_held');
    else assert.ok(['process_held', 'proc_unreadable'].includes(report.reason));
    assert.ok(existsSync(wt));
  } finally {
    child.kill('SIGKILL');
  }
});

void test('keeps a worktree a process holds a file open in, and keeps all when /proc is unreadable', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'open-file');
  mkdirSync(join(fx.procRoot, '4242', 'fd'), { recursive: true });
  symlinkSync('/', join(fx.procRoot, '4242', 'cwd'));
  symlinkSync(join(wt, 'README.md'), join(fx.procRoot, '4242', 'fd', '3'));
  writeFileSync(join(fx.procRoot, '4242', 'maps'), '');

  const held = runGc(fx);
  assert.equal(reportFor(held.summary, wt).reason, 'process_held');

  const blind = runGc(fx, [], { WORKTREE_GC_PROC_ROOT: join(fx.tmp, 'no-such-proc') });
  assert.equal(reportFor(blind.summary, wt).reason, 'proc_unreadable');
  assert.ok(existsSync(wt));
});

void test('keeps worktrees outside the allow-listed roots and under protected paths', () => {
  const fx = fixture();
  const elsewhere = join(fx.tmp, 'elsewhere');
  mkdirSync(elsewhere);
  const outside = addWorktree(fx, 'outside', { under: elsewhere });
  const deployDir = join(fx.roots, 'deploy');
  mkdirSync(deployDir);
  const rollback = addWorktree(fx, 'rollback-abc', { under: deployDir });

  const { summary } = runGc(fx, [], { WORKTREE_GC_EXTRA_PROTECTED: deployDir });

  assert.equal(reportFor(summary, outside).reason, 'outside_roots');
  assert.equal(reportFor(summary, rollback).reason, 'protected_path');
  assert.ok(existsSync(outside));
  assert.ok(existsSync(rollback));
});

void test('the deploy state tree is protected even when a root covers it', () => {
  assert.ok(BUILTIN_PROTECTED.includes('/var/lib/aqua/deploy'));
  assert.equal(
    classifyLocation(
      '/var/lib/aqua/deploy/rollback-34db380f9',
      null,
      ['/var/lib/aqua'],
      BUILTIN_PROTECTED,
    ),
    'protected_path',
  );
  assert.equal(
    classifyLocation('/var/lib/aqua/deploy', null, ['/var/lib'], BUILTIN_PROTECTED),
    'protected_path',
  );
  const config = readConfig([], {
    WORKTREE_GC_ROOTS: '/var/lib/aqua',
    WORKTREE_GC_EXTRA_PROTECTED: '',
  });
  assert.ok(config.protectedPaths.includes('/var/lib/aqua/deploy'));
});

void test('keeps a worktree that contains another worktree', () => {
  const fx = fixture();
  const outer = addWorktree(fx, 'outer');
  const inner = addWorktree(fx, 'inner', { under: join(outer, '.state') });
  backdate(outer);

  const { summary } = runGc(fx);

  assert.equal(reportFor(summary, outer).reason, 'contains_worktree');
  assert.equal(reportFor(summary, inner).decision, 'removed');
  assert.ok(existsSync(join(outer, 'README.md')));
});

void test('removes nothing and exits 1 when the fetch fails', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'would-go');
  git(['-C', fx.repo, 'remote', 'set-url', 'origin', join(fx.tmp, 'gone.git')]);

  const { summary, exitCode } = runGc(fx);

  assert.equal(exitCode, 1);
  assert.equal(summary.fatal?.kind, 'fetch_failed');
  assert.deepEqual(summary.worktrees, []);
  assert.ok(existsSync(wt));
});

void test('exits 1 on a path that is not a repository', () => {
  const fx = fixture();
  const { summary, exitCode } = runGc(fx, [], { AQUA_REPO: join(fx.tmp, 'wt') });
  assert.equal(exitCode, 1);
  assert.equal(summary.fatal?.kind, 'not_a_repo');
});

void test('dry run reports the same decision, removes nothing, and does not make the worktree look active', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'dry');
  const dirty = addWorktree(fx, 'dry-dirty');
  writeFileSync(join(dirty, 'README.md'), 'edit\n');

  const first = runGc(fx, ['--dry-run']);
  // Second pass via the env switch. If the first pass's `git status` had
  // refreshed the index, the worktree would now read as recently active.
  const second = runGc(fx, [], { WORKTREE_GC_DRY_RUN: '1' });

  for (const pass of [first, second]) {
    assert.equal(pass.exitCode, 0);
    assert.equal(reportFor(pass.summary, wt).decision, 'would_remove');
    assert.equal(reportFor(pass.summary, dirty).reason, 'merged_but_dirty');
    assert.equal(pass.summary.prune, 'skipped_dry_run');
  }
  assert.ok(existsSync(wt));
  assert.ok(existsSync(dirty));
});

void test('parses porcelain -z records including locked and prunable', () => {
  const raw = [
    'worktree /repo',
    'bare',
    '',
    'worktree /repo/.worktrees/a',
    'HEAD abc',
    'branch refs/heads/feat/a',
    '',
    'worktree /root/wt/b',
    'HEAD def',
    'detached',
    'locked reason here',
    '',
    'worktree /root/wt/c',
    'HEAD 123',
    'detached',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\0');

  const records = parseWorktreeList(raw);

  assert.equal(records.length, 4);
  assert.equal(records[0]?.bare, true);
  assert.equal(records[1]?.branch, 'feat/a');
  assert.equal(records[2]?.locked, true);
  assert.equal(records[3]?.prunable, true);
});

void test('a path held by a deleted-file mapping still counts', () => {
  const held = heldWorktrees(new Set(['/root/wt/a/node_modules/x.node (deleted)', '/elsewhere']), [
    '/root/wt/a',
    '/root/wt/b',
  ]);
  assert.deepEqual([...held], ['/root/wt/a']);
});

void test('configuration that would widen the blast radius is refused', () => {
  assert.throws(() => readConfig([], { WORKTREE_GC_ROOTS: '/' }));
  assert.throws(() => readConfig([], { WORKTREE_GC_ROOTS: 'relative/wt' }));
  assert.throws(() => readConfig([], { WORKTREE_GC_GRACE_HOURS: '0.1' }));
  assert.throws(() => readConfig(['--force'], {}));
  const defaults = readConfig([], { AQUA_REPO: '/var/aqua-saas' });
  assert.deepEqual(defaults.roots, ['/var/aqua-saas/.worktrees', '/root/wt']);
  assert.equal(defaults.graceMs, 6 * 3600 * 1000);
  assert.equal(defaults.dryRun, false);
});
