#!/usr/bin/env node
/**
 * ARIA's rules for the collector (ARIA owner, 2026-10-09): canonical ARIA
 * state is never collectable whatever the roots say; inside
 * <repo>/.worktrees the ARIA byproducts aria-findings/, .aria-ci/ and
 * aria-tools/** are disposable; an aria-tools/ that was used as a real store
 * keeps its worktree.
 *
 * Run: npm run tools:test
 */
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { BUILTIN_PROTECTED, classifyLocation, isAriaStatePath } from './gc-config.ts';
import { addWorktree, fixture, reportFor, runGc, type Fixture } from './gc-test-fixture.ts';
import { isRebuildableCache } from './worktree-state.ts';

function writeByproducts(worktree: string): void {
  for (const dir of ['aria-findings', '.aria-ci', 'aria-tools']) mkdirSync(join(worktree, dir));
  writeFileSync(join(worktree, 'aria-findings', 'f-001.json'), '{}\n');
  writeFileSync(join(worktree, '.aria-ci', 'evidence.json'), '{}\n');
  writeFileSync(join(worktree, 'aria-tools', 'cycles.jsonl'), '{}\n');
}

function agentRoot(fx: Fixture): string {
  const root = join(fx.repo, '.worktrees');
  mkdirSync(root, { recursive: true });
  return root;
}

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

void test('ARIA byproducts are disposable inside <repo>/.worktrees and nowhere else', () => {
  const fx = fixture();
  const agent = addWorktree(fx, 'agent', { under: agentRoot(fx) });
  writeByproducts(agent);
  const other = addWorktree(fx, 'other');
  writeByproducts(other);

  const run = runGc(fx, [], { WORKTREE_GC_ROOTS: `${join(fx.repo, '.worktrees')}:${fx.roots}` });

  assert.equal(reportFor(run, agent).decision, 'removed');
  assert.equal(reportFor(run, other).reason, 'ignored_content');
  assert.ok(existsSync(join(other, 'aria-tools', 'cycles.jsonl')));
  assert.ok(isRebuildableCache('aria-tools/cycles.jsonl', true));
  assert.equal(isRebuildableCache('aria-tools/cycles.jsonl', false), false);
  assert.equal(isRebuildableCache('docs/aria-findings/x', true), false);
});

void test('an agent worktree whose aria-tools was used as a real store is kept', () => {
  const fx = fixture();
  const root = agentRoot(fx);
  const withStateGit = addWorktree(fx, 'state-git', { under: root });
  writeByproducts(withStateGit);
  mkdirSync(join(withStateGit, 'aria-tools', 'nested', 'state.git'), { recursive: true });
  const large = addWorktree(fx, 'large', { under: root });
  writeByproducts(large);
  writeFileSync(join(large, 'aria-tools', 'ledger.jsonl'), '');
  truncateSync(join(large, 'aria-tools', 'ledger.jsonl'), 51 * 1024 * 1024);
  const topStore = addWorktree(fx, 'top-store', { under: root });
  mkdirSync(join(topStore, '.aria-state-store'));
  writeFileSync(join(topStore, '.aria-state-store', 'HEAD'), 'ref: refs/heads/state\n');

  const run = runGc(fx, [], { WORKTREE_GC_ROOTS: root });

  for (const [wt, why] of [
    [withStateGit, /state\.git/],
    [large, /50 MB/],
    [topStore, /\.aria-state-store/],
  ] as const) {
    const report = reportFor(run, wt);
    assert.equal(report.reason, 'aria_store', wt);
    assert.match(String(report.detail), why);
    assert.ok(existsSync(wt));
  }
  assert.equal(run.summary.counts.kept_aria_store, 3);
});
