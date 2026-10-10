#!/usr/bin/env node
/**
 * The porcelain parser is shared by the collector and the inventory audit,
 * so its contract is pinned once, here: against a hand-written record set
 * and against what the installed git actually prints.
 *
 * Run: npm run tools:test
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { WORKTREE_LIST_ARGS, parseWorktreeList, shortBranch } from './worktree-list.ts';

const HOOK_GIT_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
];

function git(args: string[]): string {
  const inherited = Object.entries(process.env).filter(([key]) => !HOOK_GIT_VARS.includes(key));
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...Object.fromEntries(inherited),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'list-test',
      GIT_AUTHOR_EMAIL: 'list-test@example.invalid',
      GIT_COMMITTER_NAME: 'list-test',
      GIT_COMMITTER_EMAIL: 'list-test@example.invalid',
    },
  });
}

void test('parses every field of a porcelain -z record set', () => {
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

  assert.deepEqual(parseWorktreeList(raw), [
    {
      path: '/repo',
      head: null,
      branch: null,
      bare: true,
      detached: false,
      locked: false,
      prunable: false,
    },
    {
      path: '/repo/.worktrees/a',
      head: 'abc',
      branch: 'refs/heads/feat/a',
      bare: false,
      detached: false,
      locked: false,
      prunable: false,
    },
    {
      path: '/root/wt/b',
      head: 'def',
      branch: null,
      bare: false,
      detached: true,
      locked: true,
      prunable: false,
    },
    {
      path: '/root/wt/c',
      head: '123',
      branch: null,
      bare: false,
      detached: true,
      locked: false,
      prunable: true,
    },
  ]);
});

void test('reads what the installed git prints, including a path with a newline', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'wtlist-')));
  const repo = join(tmp, 'repo');
  git(['init', '--quiet', '-b', 'main', repo]);
  writeFileSync(join(repo, 'README.md'), 'x\n');
  git(['-C', repo, 'add', '.']);
  git(['-C', repo, 'commit', '--quiet', '-m', 'seed']);
  const branched = join(tmp, 'feat');
  const odd = join(tmp, 'line\nbreak');
  git(['-C', repo, 'worktree', 'add', '--quiet', '-b', 'feat/x', branched]);
  git(['-C', repo, 'worktree', 'add', '--quiet', '--detach', odd]);
  git(['-C', repo, 'worktree', 'lock', '--reason', 'held by test', odd]);

  const records = parseWorktreeList(git(['-C', repo, ...WORKTREE_LIST_ARGS]));

  assert.deepEqual(
    records.map((r) => [r.path, shortBranch(r.branch), r.detached, r.locked]),
    [
      [repo, 'main', false, false],
      [branched, 'feat/x', false, false],
      [odd, null, true, true],
    ],
  );
  assert.ok(records.every((r) => r.head !== null && /^[0-9a-f]{40}$/.test(r.head)));
});
