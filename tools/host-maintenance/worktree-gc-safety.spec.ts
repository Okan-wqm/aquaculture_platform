#!/usr/bin/env node
/**
 * The hardening an independent review of the collector asked for, pinned
 * against real git repositories: ignored files that are somebody's data,
 * re-checking right before acting, commits only a reflog still holds,
 * half-done git operations, per-worktree refs, symlinks from other
 * worktrees, the prune guard, pass limits, a bare-configured main checkout,
 * interrupted moves, and the shape of the journal output.
 *
 * Run: npm run tools:test
 */
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { QUARANTINE_DIR } from './gc-quarantine.ts';
import {
  addWorktree,
  backdate,
  fixture,
  git,
  OLD_ENV,
  reportFor,
  runGc,
  wrappedGit,
} from './gc-test-fixture.ts';
import { isRebuildableCache } from './worktree-state.ts';

void test('keeps a worktree whose ignored files are not rebuildable caches', () => {
  const fx = fixture();
  const review = addWorktree(fx, 'review-state');
  mkdirSync(join(review, '.full-review'));
  writeFileSync(join(review, '.full-review', 'state.json'), '{"phase":3}\n');
  const caches = addWorktree(fx, 'caches-only');
  mkdirSync(join(caches, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(caches, 'node_modules', 'pkg', 'index.js'), '\n');
  mkdirSync(join(caches, 'dist'));
  writeFileSync(join(caches, 'dist', 'main.js'), '\n');
  mkdirSync(join(caches, 'tools', '__pycache__'), { recursive: true });
  writeFileSync(join(caches, 'tools', '__pycache__', 'x.cpython-312.pyc'), '\n');

  const run = runGc(fx);

  const kept = reportFor(run, review);
  assert.equal(kept.reason, 'ignored_content');
  assert.match(String(kept.detail), /\.full-review\//);
  assert.ok(existsSync(join(review, '.full-review', 'state.json')));
  assert.equal(reportFor(run, caches).decision, 'removed');
  assert.ok(run.summary.attention.some((a) => a.path === review && a.reason === 'ignored_content'));
});

void test('only named build and dependency caches count as rebuildable', () => {
  for (const path of [
    'node_modules',
    'apps/x/node_modules/',
    'dist/',
    '.nx/',
    'a/__pycache__/',
    'x.tsbuildinfo',
    '.husky/_/',
    '.husky/_/.gitignore',
  ]) {
    assert.ok(isRebuildableCache(path), path);
  }
  for (const path of [
    '.full-review/',
    'aria-tools/cycles.jsonl',
    'aria-findings/',
    '.env',
    'keys/id_ed25519',
    '.husky/pre-commit',
    'apps/x/.husky/_/husky.sh',
  ]) {
    assert.equal(isRebuildableCache(path), false, path);
  }
});

void test('re-checks a candidate immediately before acting on it', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'turns-dirty');
  // The first `git status` (the reporting pass) succeeds and then somebody
  // starts working: a file appears. The removal must see it.
  const marker = join(fx.tmp, 'dirtied');
  const dirtying = wrappedGit(
    fx,
    'dirtying-git',
    '*" status "*',
    `if [ ! -e ${marker} ]; then touch ${marker}; "$REAL_GIT" "$@"; rc=$?; echo work > ${join(wt, 'new.txt')}; exit $rc; fi`,
  );

  const run = runGc(fx, [], { AQUA_GIT_BIN: dirtying });

  assert.equal(reportFor(run, wt).reason, 'merged_but_dirty');
  assert.ok(existsSync(join(wt, 'new.txt')));
});

void test('keeps a worktree whose reflog alone holds a commit', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'reset-away');
  writeFileSync(join(wt, 'lost.txt'), 'work nobody pushed\n');
  git(['-C', wt, 'add', 'lost.txt']);
  git(['-C', wt, 'commit', '--quiet', '-m', 'unpushed'], OLD_ENV);
  git(['-C', wt, 'reset', '--quiet', '--hard', 'origin/main'], OLD_ENV);
  backdate(wt);

  const report = reportFor(runGc(fx), wt);

  assert.equal(report.reason, 'unreachable_reflog');
  assert.ok(existsSync(wt));
});

void test('keeps a worktree with a half-done git operation or its own refs', () => {
  const fx = fixture();
  const bisecting = addWorktree(fx, 'bisecting');
  git(['-C', bisecting, 'bisect', 'start'], OLD_ENV);
  backdate(bisecting);
  const tagged = addWorktree(fx, 'worktree-ref');
  git(['-C', tagged, 'update-ref', 'refs/worktree/keep', 'HEAD'], OLD_ENV);
  backdate(tagged);

  const run = runGc(fx);

  assert.equal(reportFor(run, bisecting).reason, 'operation_in_progress');
  assert.equal(reportFor(run, tagged).reason, 'worktree_refs');
  assert.ok(existsSync(bisecting));
  assert.ok(existsSync(tagged));
});

void test('keeps a worktree another worktree links into', () => {
  const fx = fixture();
  const provider = addWorktree(fx, 'provider');
  mkdirSync(join(provider, 'node_modules'));
  const nestedProvider = addWorktree(fx, 'nested-provider');
  mkdirSync(join(nestedProvider, 'node_modules'));
  const elsewhere = join(fx.tmp, 'elsewhere');
  mkdirSync(elsewhere);
  const consumer = addWorktree(fx, 'consumer', { under: elsewhere });
  symlinkSync(join(provider, 'node_modules'), join(consumer, 'node_modules'));
  writeFileSync(join(consumer, 'package.json'), '{"workspaces":["libs/*"]}\n');
  mkdirSync(join(consumer, 'libs', 'a'), { recursive: true });
  symlinkSync(join(nestedProvider, 'node_modules'), join(consumer, 'libs', 'a', 'node_modules'));

  const run = runGc(fx);

  assert.equal(reportFor(run, provider).reason, 'symlink_target');
  assert.equal(reportFor(run, nestedProvider).reason, 'symlink_target');
  assert.ok(existsSync(join(provider, 'node_modules')));
});

void test('does not prune the record of a missing worktree outside the roots', () => {
  const fx = fixture();
  const scratch = join(fx.tmp, 'scratchpad');
  mkdirSync(scratch);
  const vanished = addWorktree(fx, 'other-session', { under: scratch });
  rmSync(vanished, { recursive: true, force: true });
  addWorktree(fx, 'ours');

  const run = runGc(fx);

  assert.equal(run.summary.prune, 'skipped_prunable_outside_roots');
  assert.match(
    git(['-C', fx.repo, 'worktree', 'list', '--porcelain']),
    new RegExp(`worktree ${vanished}\n`),
  );
});

void test('stops at the per-pass removal cap and the pass budget', () => {
  const fx = fixture();
  const first = addWorktree(fx, 'cap-a');
  const second = addWorktree(fx, 'cap-b');

  const capped = runGc(fx, [], { WORKTREE_GC_MAX_REMOVALS: '1' });

  const decisions = [reportFor(capped, first), reportFor(capped, second)]
    .map((r) => r.reason)
    .sort();
  assert.deepEqual(decisions, ['eligible', 'pass_cap']);
  assert.equal(capped.summary.counts.removed, 1);

  const fx2 = fixture();
  const late = addWorktree(fx2, 'late');
  const outOfTime = runGc(fx2, [], { WORKTREE_GC_PASS_BUDGET_SECONDS: '0' });
  assert.equal(reportFor(outOfTime, late).reason, 'pass_budget');
  assert.ok(existsSync(late));
});

void test('collects from a main checkout configured core.bare=true, as on the droplet', () => {
  const fx = fixture({ bareMain: true });
  const wt = addWorktree(fx, 'from-bare');

  const run = runGc(fx);

  assert.equal(run.worktrees[0]?.reason, 'main_checkout');
  assert.equal(reportFor(run, wt).decision, 'removed');
});

void test('repairs a tree whose move into quarantine was interrupted, then finishes it', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'half-moved');
  mkdirSync(join(fx.roots, QUARANTINE_DIR));
  const orphan = join(fx.roots, QUARANTINE_DIR, 'half-moved');
  renameSync(wt, orphan);

  const first = runGc(fx);
  assert.equal(reportFor(first, orphan).reason, 'quarantine_orphan');
  assert.match(String(reportFor(first, orphan).detail), /repaired/);

  const second = runGc(fx);
  assert.equal(reportFor(second, orphan).decision, 'removed');
  assert.equal(existsSync(orphan), false);
});

void test('journal output: one short line per worktree, routine keeps left out of the summary', () => {
  const fx = fixture();
  const removed = addWorktree(fx, 'gone');
  const dirty = addWorktree(fx, 'dirty');
  writeFileSync(join(dirty, 'README.md'), 'edit\n');
  addWorktree(fx, 'young', { old: false });

  const run = runGc(fx);

  assert.ok(run.lines.every((line) => line.length < 4096));
  assert.equal(run.worktrees.length, run.summary.counts.total);
  assert.deepEqual(
    run.summary.removals.map((r) => r.path),
    [removed],
  );
  assert.deepEqual(
    run.summary.attention.map((a) => a.reason),
    ['merged_but_dirty'],
  );
});

void test('a tree whose .git file git already deleted is cleared from quarantine', () => {
  const fx = fixture();
  const quarantine = join(fx.roots, QUARANTINE_DIR);
  mkdirSync(quarantine);
  const wt = addWorktree(fx, 'stranded');
  const moved = join(quarantine, 'stranded');
  git(['-C', fx.repo, 'worktree', 'move', wt, moved]);
  rmSync(join(moved, '.git'));
  rmSync(join(moved, 'README.md'));
  // A stale record outside the roots blocks the global prune, as /tmp
  // scratchpads do on the droplet; the stranded tree must not depend on it.
  const scratch = join(fx.tmp, 'scratchpad');
  mkdirSync(scratch);
  rmSync(addWorktree(fx, 'other-session', { under: scratch }), { recursive: true, force: true });
  // An unregistered stranded entry, with a symlink that points outside.
  const outside = join(fx.tmp, 'precious');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'not ours\n');
  const orphan = join(quarantine, 'orphan');
  mkdirSync(orphan);
  symlinkSync(outside, join(orphan, 'link'));

  const run = runGc(fx);

  assert.equal(run.summary.prune, 'skipped_prunable_outside_roots');
  assert.equal(reportFor(run, moved).decision, 'removed');
  assert.equal(existsSync(moved), false);
  assert.doesNotMatch(git(['-C', fx.repo, 'worktree', 'list', '--porcelain']), /stranded/);
  assert.equal(reportFor(run, orphan).decision, 'removed');
  assert.equal(existsSync(orphan), false);
  assert.equal(existsSync(join(outside, 'keep.txt')), true);
});

void test('a quarantine entry that resolves outside the quarantine is not deleted', () => {
  const fx = fixture();
  const quarantine = join(fx.roots, QUARANTINE_DIR);
  mkdirSync(quarantine);
  const outside = join(fx.tmp, 'precious');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'not ours\n');
  const planted = join(quarantine, 'planted');
  symlinkSync(outside, planted);

  const run = runGc(fx);

  assert.equal(reportFor(run, planted).decision, 'remove_failed');
  assert.match(String(reportFor(run, planted).detail), /outside the quarantine/);
  assert.equal(existsSync(join(outside, 'keep.txt')), true);
});
