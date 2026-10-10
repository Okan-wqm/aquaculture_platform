#!/usr/bin/env node
/**
 * The collector deletes directories on the production host, so every
 * decision it makes to KEEP something is pinned here against real git
 * repositories (see gc-test-fixture.ts). This file covers the core keep and
 * remove rules; worktree-gc-safety.spec.ts covers the hardening an
 * independent review asked for.
 *
 * Run: npm run tools:test
 */
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { BUILTIN_PROTECTED, classifyLocation, readConfig } from './gc-config.ts';
import { QUARANTINE_DIR } from './gc-quarantine.ts';
import {
  addWorktree,
  fakeProcess,
  fixture,
  git,
  isRoot,
  reportFor,
  runGc,
  wrappedGit,
} from './gc-test-fixture.ts';
import { executePass } from './worktree-gc.ts';

void test('removes a merged, clean, idle worktree and keeps its branch and the main checkout', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'merged-clean');
  // node_modules on the droplet is often a symlink into the main checkout.
  // Removal must unlink it, never follow it.
  const shared = join(fx.tmp, 'shared-modules');
  mkdirSync(shared);
  writeFileSync(join(shared, 'keep.txt'), 'not ours\n');
  symlinkSync(shared, join(wt, 'node_modules'));

  const run = runGc(fx);

  assert.equal(run.exitCode, 0);
  assert.equal(reportFor(run, wt).decision, 'removed');
  assert.equal(existsSync(wt), false);
  assert.equal(existsSync(join(shared, 'keep.txt')), true);
  assert.deepEqual(readdirSync(join(fx.roots, QUARANTINE_DIR)), []);
  assert.equal(reportFor(run, fx.repo).reason, 'main_checkout');
  assert.ok(existsSync(join(fx.repo, 'README.md')));
  git(['-C', fx.repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/merged-clean']);
  assert.equal(run.summary.prune, 'ok');
  assert.equal(typeof run.summary.bytes_reclaimed_estimate, 'number');
  assert.match(readFileSync(fx.textfile, 'utf8'), /^aqua_worktree_gc_last_exit_code 0$/m);
});

void test('keeps merged worktrees that carry uncommitted or untracked work', () => {
  const fx = fixture();
  const tracked = addWorktree(fx, 'dirty-tracked');
  writeFileSync(join(tracked, 'README.md'), 'unsaved edit\n');
  const untracked = addWorktree(fx, 'dirty-untracked');
  writeFileSync(join(untracked, 'notes.txt'), 'scratch\n');

  const run = runGc(fx);

  for (const wt of [tracked, untracked]) {
    assert.equal(reportFor(run, wt).reason, 'merged_but_dirty');
    assert.ok(existsSync(wt));
  }
  assert.equal(run.summary.counts.kept_merged_but_dirty, 2);
});

void test('keeps a worktree whose HEAD is not in origin/main', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'unmerged');
  writeFileSync(join(wt, 'feature.txt'), 'work\n');
  git(['-C', wt, 'add', 'feature.txt']);
  git(['-C', wt, 'commit', '--quiet', '-m', 'feature']);

  assert.equal(reportFor(runGc(fx), wt).reason, 'unmerged');
  assert.ok(existsSync(wt));
});

void test('keeps a merged, clean worktree inside the grace period', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'fresh', { old: false });

  assert.equal(reportFor(runGc(fx), wt).reason, 'recently_active');
  assert.ok(existsSync(wt));
});

void test('keeps a locked worktree', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'locked');
  git(['-C', fx.repo, 'worktree', 'lock', wt]);

  assert.equal(reportFor(runGc(fx), wt).reason, 'locked');
  assert.ok(existsSync(wt));
});

void test('keeps a worktree a live process has as its cwd (real /proc)', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'in-use');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: wt,
    stdio: 'ignore',
  });
  try {
    const report = reportFor(runGc(fx, [], { WORKTREE_GC_PROC_ROOT: null }), wt);
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

void test('keeps a worktree held through a cwd, an open fd, or a mapped file', () => {
  const holds: Array<[string, (wt: string) => { cwd?: string; fds?: string[]; maps?: string[] }]> =
    [
      ['cwd', (wt) => ({ cwd: join(wt, '.') })],
      ['fd', (wt) => ({ fds: [join(wt, 'README.md')] })],
      ['maps', (wt) => ({ maps: [join(wt, 'node_modules', 'addon.node')] })],
    ];
  for (const [kind, hold] of holds) {
    const fx = fixture();
    const wt = addWorktree(fx, `held-${kind}`);
    fakeProcess(fx, 4242, hold(wt));
    assert.equal(reportFor(runGc(fx), wt).reason, 'process_held', kind);
    assert.ok(existsSync(wt), kind);
  }
});

void test('keeps everything when /proc cannot be read', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'blind');

  const run = runGc(fx, [], { WORKTREE_GC_PROC_ROOT: join(fx.tmp, 'no-such-proc') });

  assert.equal(reportFor(run, wt).reason, 'proc_unreadable');
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

  const run = runGc(fx, [], { WORKTREE_GC_EXTRA_PROTECTED: deployDir });

  assert.equal(reportFor(run, outside).reason, 'outside_roots');
  assert.equal(reportFor(run, rollback).reason, 'protected_path');
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
    WORKTREE_GC_ARCHIVE_ROOT: '/srv/worktree-gc-archive',
  });
  assert.ok(config.protectedPaths.includes('/var/lib/aqua/deploy'));
});

void test('keeps a worktree that contains another worktree', () => {
  const fx = fixture();
  const outer = addWorktree(fx, 'outer');
  const inner = addWorktree(fx, 'inner', { under: join(outer, '.state') });

  const run = runGc(fx);

  assert.equal(reportFor(run, outer).reason, 'contains_worktree');
  assert.equal(reportFor(run, inner).decision, 'removed');
  assert.ok(existsSync(join(outer, 'README.md')));
});

void test('removes nothing and exits 1 when the fetch fails', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'would-go');
  git(['-C', fx.repo, 'remote', 'set-url', 'origin', join(fx.tmp, 'gone.git')]);

  const run = runGc(fx);

  assert.equal(run.exitCode, 1);
  assert.equal(run.summary.fatal?.kind, 'fetch_failed');
  assert.deepEqual(run.worktrees, []);
  assert.ok(existsSync(wt));
  assert.match(readFileSync(fx.textfile, 'utf8'), /^aqua_worktree_gc_last_exit_code 1$/m);
});

void test('a pass refused for bad configuration still writes the textfile', () => {
  const fx = fixture();
  const run = runGc(fx, [], { WORKTREE_GC_GRACE_HOURS: '0' });
  assert.equal(run.exitCode, 1);
  assert.equal(run.summary.fatal?.kind, 'bad_config');
  assert.match(readFileSync(fx.textfile, 'utf8'), /^aqua_worktree_gc_last_exit_code 1$/m);
});

void test('exits 1 on a path that is not a repository', () => {
  const fx = fixture();
  const run = runGc(fx, [], { AQUA_REPO: join(fx.tmp, 'wt') });
  assert.equal(run.exitCode, 1);
  assert.equal(run.summary.fatal?.kind, 'not_a_repo');
});

void test('an unarmed pass and a --dry-run pass report the same decisions and remove nothing', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'dry');
  const dirty = addWorktree(fx, 'dry-dirty');
  writeFileSync(join(dirty, 'README.md'), 'edit\n');

  const unarmed = runGc(fx, [], { WORKTREE_GC_ARMED: null });
  assert.match(
    readFileSync(fx.textfile, 'utf8'),
    /^aqua_worktree_gc_unarmed_since_timestamp_seconds \d+$/m,
  );
  // If the first pass's `git status` had refreshed the index, the second
  // would see the worktree as recently active.
  const dryRun = runGc(fx, ['--dry-run']);

  assert.equal(unarmed.summary.armed, false);
  for (const pass of [unarmed, dryRun]) {
    assert.equal(pass.exitCode, 0);
    assert.equal(pass.summary.dry_run, true);
    assert.equal(reportFor(pass, wt).decision, 'would_remove');
    assert.equal(reportFor(pass, dirty).reason, 'merged_but_dirty');
    assert.equal(pass.summary.prune, 'skipped_dry_run');
  }
  assert.ok(existsSync(wt));
  assert.ok(existsSync(dirty));
});

void test('a removal git refuses is moved back, kept, and the pass exits 3', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'refused');
  // Somebody starts working after the final re-check: a file appears in the
  // tree between the move and the removal, and the real git refuses.
  const intruding = wrappedGit(
    fx,
    'intruding-git',
    '*"worktree remove"*',
    'for last; do :; done; echo work > "$last/notes.txt"',
  );

  const run = runGc(fx, [], { AQUA_GIT_BIN: intruding });

  assert.equal(run.exitCode, 3);
  const report = reportFor(run, wt);
  assert.equal(report.decision, 'kept');
  assert.equal(report.reason, 'remove_refused');
  assert.equal(run.summary.counts.kept_remove_refused, 1);
  assert.equal(readFileSync(join(wt, 'notes.txt'), 'utf8'), 'work\n');
  assert.deepEqual(readdirSync(join(fx.roots, QUARANTINE_DIR)), []);
  assert.match(
    git(['-C', fx.repo, 'worktree', 'list', '--porcelain']),
    new RegExp(`worktree ${wt}\n`),
  );
  assert.match(readFileSync(fx.textfile, 'utf8'), /^aqua_worktree_gc_last_exit_code 3$/m);
});

void test('a removal that failed after it began deleting stays in quarantine', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'half-deleted');
  // git deletes part of the tree, then fails on a busy file. Moving that
  // back would hand its owner a damaged checkout.
  const busy = wrappedGit(
    fx,
    'busy-git',
    '*"worktree remove"*',
    'for last; do :; done; rm -f "$last/README.md"; echo "error: failed to delete: Device or resource busy" >&2; exit 128',
  );

  const first = runGc(fx, [], { AQUA_GIT_BIN: busy });

  assert.equal(first.exitCode, 3);
  assert.equal(reportFor(first, wt).decision, 'remove_failed');
  assert.match(String(reportFor(first, wt).detail), /removal had begun/);
  assert.equal(existsSync(wt), false);
  const [left] = readdirSync(join(fx.roots, QUARANTINE_DIR));
  assert.ok(left);
  const leftover = join(fx.roots, QUARANTINE_DIR, left);

  const second = runGc(fx);
  assert.equal(reportFor(second, leftover).decision, 'removed');
  assert.equal(existsSync(leftover), false);
});

void test('a quarantine that cannot be created fails the removal, not the pass', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'no-room');
  writeFileSync(join(fx.roots, QUARANTINE_DIR), 'a file where the quarantine should be\n');

  const run = runGc(fx);

  assert.equal(run.exitCode, 3);
  assert.equal(reportFor(run, wt).decision, 'remove_failed');
  assert.match(String(reportFor(run, wt).detail), /cannot create quarantine/);
  assert.ok(existsSync(join(wt, 'README.md')));
  assert.match(readFileSync(fx.textfile, 'utf8'), /^aqua_worktree_gc_last_exit_code 3$/m);
});

void test('an exception nobody anticipated still writes a fatal summary and the textfile', () => {
  const fx = fixture();
  const lines: string[] = [];

  const exitCode = executePass(
    [],
    { AQUA_REPO: fx.repo, WORKTREE_GC_TEXTFILE_PATH: fx.textfile },
    (l) => {
      lines.push(l);
    },
    () => {
      throw new Error('ENOSPC: no space left on device, write');
    },
  );

  assert.equal(exitCode, 1);
  assert.match(lines.join(''), /"kind":"crash".*ENOSPC/);
  assert.match(readFileSync(fx.textfile, 'utf8'), /^aqua_worktree_gc_last_exit_code 1$/m);
});

void test('an interrupted removal is finished only while nothing but the removal touched it', () => {
  const fx = fixture();
  const quarantine = join(fx.roots, QUARANTINE_DIR);
  mkdirSync(quarantine);
  const half = addWorktree(fx, 'half');
  const halfMoved = join(quarantine, 'half');
  git(['-C', fx.repo, 'worktree', 'move', half, halfMoved]);
  rmSync(join(halfMoved, 'README.md'));
  mkdirSync(join(halfMoved, 'node_modules'));
  const touched = addWorktree(fx, 'touched');
  const touchedMoved = join(quarantine, 'touched');
  git(['-C', fx.repo, 'worktree', 'move', touched, touchedMoved]);
  rmSync(join(touchedMoved, 'README.md'));
  writeFileSync(join(touchedMoved, 'notes.txt'), 'somebody worked here\n');

  const run = runGc(fx);

  assert.equal(reportFor(run, halfMoved).decision, 'removed');
  assert.equal(existsSync(halfMoved), false);
  assert.equal(reportFor(run, touchedMoved).reason, 'merged_but_dirty');
  assert.ok(existsSync(join(touchedMoved, 'notes.txt')));
});

void test('configuration that would widen the blast radius is refused', () => {
  assert.throws(() => readConfig([], { WORKTREE_GC_ROOTS: '/' }));
  assert.throws(() => readConfig([], { WORKTREE_GC_ROOTS: 'relative/wt' }));
  assert.throws(() => readConfig([], { WORKTREE_GC_GRACE_HOURS: '0.1' }));
  assert.throws(() => readConfig([], { WORKTREE_GC_MAX_REMOVALS: '0' }));
  assert.throws(() => readConfig(['--force'], {}));
  const defaults = readConfig([], { AQUA_REPO: '/var/aqua-saas' });
  assert.deepEqual(defaults.roots, ['/var/aqua-saas/.worktrees', '/root/wt']);
  assert.equal(defaults.graceMs, 6 * 3600 * 1000);
  assert.equal(defaults.armed, false);
  assert.equal(defaults.dryRun, true);
  assert.equal(readConfig([], { WORKTREE_GC_ARMED: '1' }).dryRun, false);
  assert.equal(readConfig([], { WORKTREE_GC_ARMED: 'yes' }).dryRun, true);
});
