#!/usr/bin/env node
/**
 * ARIA-specific structures are never deleted (user decision, 2026-10-09:
 * "ARIA'ya özgü yapılar silinmemeli"). Canonical ARIA state is never
 * collectable whatever the roots say, and a worktree that holds any ARIA
 * artifact, sits on an ARIA branch, or has an ARIA directory name is kept
 * (kept_aria) - never removed, never moved into quarantine.
 *
 * Run: npm run tools:test
 */
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { BUILTIN_PROTECTED, classifyLocation, isAriaStatePath } from './gc-config.ts';
import { QUARANTINE_DIR } from './gc-quarantine.ts';
import { addWorktree, fixture, git, reportFor, runGc } from './gc-test-fixture.ts';
import { ARIA_ARTIFACT_PATHS, ariaName } from './worktree-state.ts';

void test('canonical ARIA state is never collectable, however wide the roots', () => {
  const cases: Array<[string, string]> = [
    ['/root/aria-8b', '/root'],
    ['/root/aria-8b/.aria-state-store', '/root'],
    ['/var/lib/aria/code', '/var/lib'],
    ['/var/lib/aria-runner/work', '/var/lib'],
    ['/home/gharunner/_work/repo/repo', '/home'],
    ['/root/wt/x/.aria-state-store', '/root/wt'],
    ['/var/aqua-saas/.worktrees/a/.aria-state-store/b', '/var/aqua-saas/.worktrees'],
  ];
  for (const [path, root] of cases) {
    assert.ok(isAriaStatePath(path), path);
    assert.equal(
      classifyLocation(path, null, [root, '/'], BUILTIN_PROTECTED),
      'protected_path',
      path,
    );
  }
  assert.equal(isAriaStatePath('/root/wt/aria-8b-notes'), false);
  assert.equal(isAriaStatePath('/var/aqua-saas/.worktrees/aria-zc'), false);
});

void test('a worktree under a .aria-state-store directory is kept', () => {
  const fx = fixture();
  const storeDir = join(fx.roots, 'host', '.aria-state-store');
  mkdirSync(storeDir, { recursive: true });
  const store = addWorktree(fx, 'store', { under: storeDir });

  assert.equal(reportFor(runGc(fx), store).reason, 'protected_path');
  assert.ok(existsSync(store));
});

void test('tracked, unmodified ARIA code does not keep a worktree', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'plain');
  assert.ok(existsSync(join(wt, 'aria-tools', 'repo_identity.json')));

  const run = runGc(fx);

  assert.equal(reportFor(run, wt).decision, 'removed');
  // Still in git: removing the worktree deleted no ARIA structure.
  assert.equal(git(['-C', fx.repo, 'show', 'origin/main:aria-tools/repo_identity.json']), '{}\n');
});

void test('an untracked file under aria-tools keeps the worktree', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'untracked-ledger');
  writeFileSync(join(wt, 'aria-tools', 'cycles.jsonl'), '{}\n');

  const report = reportFor(runGc(fx), wt);

  assert.equal(report.reason, 'aria');
  assert.match(String(report.detail), /aria-tools\/cycles\.jsonl/);
  assert.ok(existsSync(join(wt, 'aria-tools', 'cycles.jsonl')));
});

void test('an ignored file under .aria-ci keeps the worktree', () => {
  const fx = fixture();
  const wt = addWorktree(fx, 'ignored-evidence');
  mkdirSync(join(wt, '.aria-ci'));
  writeFileSync(join(wt, '.aria-ci', 'evidence.json'), '{}\n');

  const report = reportFor(runGc(fx), wt);

  assert.equal(report.reason, 'aria');
  assert.match(String(report.detail), /\.aria-ci/);
  assert.ok(existsSync(join(wt, '.aria-ci', 'evidence.json')));
});

void test('every ARIA artifact path keeps a worktree that alone holds content there', () => {
  const fx = fixture();
  const files = [
    'aria-findings/F-001.json',
    'aria-worktrees/lane-1/x',
    '.aria-state-store/HEAD',
    'state.git',
    '.claude/agents/.dispatch-log.jsonl',
    'aria-agent-outputs-2026-10-09/out.json',
  ];
  assert.ok(
    ARIA_ARTIFACT_PATHS.every(
      (p) => p === 'aria-tools' || p === '.aria-ci' || files.some((f) => f.startsWith(p)),
    ),
  );
  const holders = files.map((file, i) => {
    const wt = addWorktree(fx, `holder-${i}`);
    mkdirSync(join(wt, file, '..'), { recursive: true });
    writeFileSync(join(wt, file), 'aria\n');
    return wt;
  });

  const run = runGc(fx);

  holders.forEach((wt, i) => {
    assert.equal(reportFor(run, wt).reason, 'aria', files[i]);
    assert.ok(existsSync(join(wt, files[i] ?? '')), files[i]);
  });
  const quarantine = join(fx.roots, QUARANTINE_DIR);
  assert.deepEqual(existsSync(quarantine) ? readdirSync(quarantine) : [], []);
});

void test('a worktree on an ARIA branch is kept', () => {
  const fx = fixture();
  const branches = ['aria/state-sync', 'lane/ARIA-hardening', 'claude/aria-fix', 'feat/aria-x'];
  const worktrees = branches.map((branch, i) => addWorktree(fx, `neutral-${i}`, { branch }));

  const run = runGc(fx);

  worktrees.forEach((wt, i) => {
    assert.equal(reportFor(run, wt).reason, 'aria', branches[i]);
    assert.ok(existsSync(wt));
  });
});

void test('a worktree whose directory name mentions ARIA is kept', () => {
  const fx = fixture();
  const named = addWorktree(fx, 'my-Aria-work', { branch: 'feat/unrelated' });
  const nested = join(fx.roots, 'ARIA-lanes');
  mkdirSync(nested);
  const inside = addWorktree(fx, 'lane-1', { under: nested, branch: 'feat/other' });

  const run = runGc(fx);

  assert.equal(reportFor(run, named).reason, 'aria');
  assert.equal(reportFor(run, inside).reason, 'aria');
  assert.ok(existsSync(named));
  assert.ok(existsSync(inside));
});

void test('the ARIA name matcher is explicit', () => {
  for (const ref of [
    'refs/heads/aria/x',
    'refs/heads/a/aria-b',
    'refs/heads/lane/ariax',
    'refs/heads/claude/ARIA-1',
  ]) {
    assert.ok(ariaName(ref, '/root/wt/plain'), ref);
  }
  assert.equal(ariaName('refs/heads/feat/maria-fix', '/root/wt/plain'), null);
  assert.ok(ariaName('refs/heads/feat/x', '/root/wt/variance-report'));
  assert.equal(ariaName('refs/heads/feat/x', '/root/wt/plain'), null);
});
