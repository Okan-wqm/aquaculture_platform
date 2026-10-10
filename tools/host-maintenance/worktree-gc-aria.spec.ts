#!/usr/bin/env node
/**
 * ARIA's own records are never deleted (user decision, 2026-10-09:
 * "ARIA'ya özgü yapılar silinmemeli"), and finished ARIA worktrees may be
 * removed (2026-10-10: "bitmiş ARIA worktree'leri silinsin"). Canonical ARIA
 * state is never collectable whatever the roots say; a worktree holding an
 * untracked or ignored file under an ARIA artifact path is kept (kept_aria)
 * - never removed, never moved into quarantine; an ARIA-named worktree
 * without one is judged like any other.
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
import { ARIA_ARTIFACT_PATHS } from './worktree-state.ts';

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

void test('a finished ARIA worktree is removable; one holding its own ARIA record is kept', () => {
  const fx = fixture();
  // User decision 2026-10-10: finished ARIA worktrees may be removed. The
  // name alone keeps nothing; ARIA's own records still do.
  const named = [
    addWorktree(fx, 'aria-lane-1', { branch: 'fix/aria-plan-write-scope' }),
    addWorktree(fx, 'train', { branch: 'train/aria-2026-10-07' }),
    addWorktree(fx, 'ARIA-dir', { branch: 'lane/ARIA-hardening' }),
  ];
  const withRecord = addWorktree(fx, 'aria-with-record', { branch: 'claude/aria-fix' });
  mkdirSync(join(withRecord, 'aria-findings'));
  writeFileSync(join(withRecord, 'aria-findings', 'F-001.json'), '{}\n');

  const run = runGc(fx);

  for (const wt of named) {
    assert.equal(reportFor(run, wt).decision, 'removed', wt);
    assert.equal(existsSync(wt), false, wt);
  }
  assert.equal(reportFor(run, withRecord).reason, 'aria');
  assert.ok(existsSync(join(withRecord, 'aria-findings', 'F-001.json')));
  for (const branch of [
    'fix/aria-plan-write-scope',
    'train/aria-2026-10-07',
    'lane/ARIA-hardening',
  ]) {
    git(['-C', fx.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  }
});
