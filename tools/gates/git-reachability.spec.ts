#!/usr/bin/env ts-node
/**
 * Unit tests for tools/gates/git-reachability.ts (Round-2 cluster-0,
 * PROC-HIGH-001 structural guard).
 *
 * Builds a throwaway git repository in a tmpdir:
 *
 *   c1 ──── c2        refs/remotes/origin/main → c1
 *            └─ branch-only commit (c2) NOT reachable from origin/main
 *
 * and pins the four guard verdicts:
 *   - sha on origin/main           → ok
 *   - branch-only sha              → refused with the PROC-HIGH-001 message
 *   - unknown sha                  → refused (unknown commit)
 *   - unresolvable ref             → refused fail-closed (fetch instructions)
 *
 * node:test runner; the pre-commit `tools/gates/*.spec.ts` glob picks
 * this up automatically. Total runtime ~150ms (one git init, two commits).
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { commitReachableFrom } from './git-reachability';

const repo = mkdtempSync(join(tmpdir(), 'git-reachability-spec-'));

/**
 * HERMETIC env — every GIT_* variable stripped. This spec runs inside
 * the pre-commit hook glob, and `git commit` exports GIT_DIR /
 * GIT_INDEX_FILE to hook processes; an inherited GIT_DIR overrides
 * `-C <tmpdir>` repo discovery and silently points every fixture git
 * call at the REAL repository. Incident 2026-06-10: the fixture's
 * `commit -m c1` swallowed the session's staged files into the real
 * branch and `update-ref refs/remotes/origin/main` rewrote the shared
 * remote-tracking ref. Fixture repositories MUST NOT inherit the
 * ambient git context.
 */
const HERMETIC_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);

function git(args: readonly string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: HERMETIC_ENV,
  }).trim();
}

// Identity is set repo-locally so the spec never depends on (or mutates)
// the developer's global git config.
git(['init', '--quiet', '--initial-branch=main']);
git(['config', 'user.email', 'spec@invalid.local']);
git(['config', 'user.name', 'git-reachability-spec']);

writeFileSync(join(repo, 'a.txt'), 'one\n');
git(['add', 'a.txt']);
git(['commit', '--quiet', '--no-verify', '-m', 'c1']);
const c1 = git(['rev-parse', 'HEAD']);

// Simulate the fetched remote-tracking ref the guard certifies against.
git(['update-ref', 'refs/remotes/origin/main', c1]);

git(['switch', '--quiet', '-c', 'feature']);
writeFileSync(join(repo, 'b.txt'), 'two\n');
git(['add', 'b.txt']);
git(['commit', '--quiet', '--no-verify', '-m', 'c2 (branch-only)']);
const c2 = git(['rev-parse', 'HEAD']);

void after(() => {
  rmSync(repo, { recursive: true, force: true });
});

void test('sha reachable from origin/main → ok', () => {
  const result = commitReachableFrom(repo, c1, 'origin/main');
  assert.equal(result.ok, true);
  assert.equal(result.reason, undefined);
});

void test('short-sha form of a reachable commit → ok', () => {
  const result = commitReachableFrom(repo, c1.slice(0, 9), 'origin/main');
  assert.equal(result.ok, true);
});

void test('branch-only sha → refused with post-merge ceremony instructions', () => {
  const result = commitReachableFrom(repo, c2, 'origin/main');
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /NOT reachable from origin\/main/);
  assert.match(result.reason ?? '', /PROC-HIGH-001/);
});

void test('unknown sha → refused as unknown commit', () => {
  const result = commitReachableFrom(repo, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'origin/main');
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /unknown to this repository/);
});

void test('unresolvable ref → fail-closed with fetch instructions', () => {
  const result = commitReachableFrom(repo, c1, 'origin/does-not-exist');
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /does not resolve/);
  assert.match(result.reason ?? '', /git fetch/);
});
