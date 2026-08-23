#!/usr/bin/env ts-node

/**
 * ORPHAN-MEDIUM-792 — authority-pin validity is content, not calendar.
 *
 * Server-side merges run no local pre-commit hook and may land on the next
 * UTC day after the contributor stamped the pin. The retired invariant
 * predicate (`declared Date >= newest authority-commit UTC day`) rejected
 * exactly that repository even though the declared hash matched the merged
 * tree byte for byte. These specs pin the replacement contract:
 *
 *   - a next-UTC-day merge of the stamped tree keeps the pin current;
 *   - an authority change without a re-stamp is stale BY CONTENT;
 *   - merge machinery (`.gitattributes merge=union`) that silently lands a
 *     stale pin fails closed;
 *   - the `aria-merge-authority` lane keeps checking out the GitHub
 *     merge-result tree and keeps running the docs SSoT gate;
 *   - the CLI `--check` exit code mirrors the pure verdict.
 *
 * The `Date:` line remains a descriptive stamp written by `--write` next to
 * the hash; it is normalized out of the digest and is no longer an
 * authorization predicate anywhere.
 */

import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import {
  ARIA_AUTHORITY_DATE_LINE,
  CURRENT_STATE_PATH,
  ariaAuthorityHash,
  checkAriaAuthorityHash,
  recordedAriaAuthorityHash,
  writeAriaAuthorityHash,
} from './aria-authority-hash';

const GATES_ROOT = __dirname;
const SPEC_REPO_ROOT = join(GATES_ROOT, '..', '..');
const MERGE_AUTHORITY_WORKFLOW = join(SPEC_REPO_ROOT, '.github/workflows/aria-merge-authority.yml');

const DAY_D = '2026-08-22T12:00:00Z';
const DAY_D_TEXT = '2026-08-22';
const DAY_D_PLUS_1 = '2026-08-23T12:00:00Z';
const DAY_D_PLUS_1_TEXT = '2026-08-23';

// The pre-commit hook runs every tools/gates spec with GIT_INDEX_FILE
// pointing at the HOST repository's staged index (git documents that env
// for hooks), and the library under test shells out to git in-process
// against the fixture roots. Scrub the ambient git context once, up front,
// so a fixture `git ls-files` can never enumerate the host's index — the
// same hermetic rule HERMETIC_GIT_ENV then applies to spawned commands.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('GIT_')) delete process.env[key];
}

const HERMETIC_GIT_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);

const fixtureRoots: string[] = [];

function gitAt(repoRoot: string, args: readonly string[], when?: string): string {
  const env =
    when === undefined
      ? HERMETIC_GIT_ENV
      : {
          ...HERMETIC_GIT_ENV,
          GIT_AUTHOR_DATE: when,
          GIT_COMMITTER_DATE: when,
        };
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    env,
  }).trim();
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'aria-authority-hash-'));
  fixtureRoots.push(root);
  gitAt(root, ['init', '-q', '-b', 'main']);
  gitAt(root, ['config', 'user.email', 'fixture@example.invalid']);
  gitAt(root, ['config', 'user.name', 'Authority Hash Fixture']);
  mkdirSync(dirname(join(root, CURRENT_STATE_PATH)), { recursive: true });
  writeFileSync(
    join(root, CURRENT_STATE_PATH),
    [
      '# ARIA — current state',
      '',
      `Date: ${DAY_D_TEXT}`,
      '',
      'Target ref: `origin/main`',
      '',
      'Last verified ARIA authority hash: `ARIA_AUTHORITY_HASH_SENTINEL`',
      '',
    ].join('\n'),
  );
  writeFileSync(join(root, 'docs/aria/SPEC.md'), '# spec\n\nv1\n');
  commitAll(root, 'chore: seed authority surface', DAY_D);
  return root;
}

function commitAll(repoRoot: string, message: string, when: string): void {
  gitAt(repoRoot, ['add', '-A']);
  gitAt(repoRoot, ['commit', '-q', '-m', message], when);
}

/**
 * Stamp through the production writer, then set the descriptive Date line to
 * the fixture day. The date line is normalized to a sentinel before hashing,
 * so rewriting it cannot move the digest — which is the point being pinned.
 */
function stampAtDay(repoRoot: string, day: string): void {
  writeAriaAuthorityHash(repoRoot);
  const path = join(repoRoot, CURRENT_STATE_PATH);
  const body = readFileSync(path, 'utf8').replace(ARIA_AUTHORITY_DATE_LINE, `Date: ${day}`);
  writeFileSync(path, body, 'utf8');
}

function declaredDay(repoRoot: string): string {
  const body = readFileSync(join(repoRoot, CURRENT_STATE_PATH), 'utf8');
  const match = body.match(/^Date: (\d{4}-\d{2}-\d{2})$/m)?.[1];
  assert.ok(match, 'fixture CURRENT_STATE must carry a Date line');
  return match;
}

after(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

test('a next-UTC-day merge of the stamped tree keeps the pin current', () => {
  const repo = makeRepo();
  gitAt(repo, ['checkout', '-q', '-b', 'feat/authority-change']);
  writeFileSync(join(repo, 'docs/aria/SPEC.md'), '# spec\n\nv2\n');
  stampAtDay(repo, DAY_D_TEXT);
  commitAll(repo, 'feat: authority change with a stamped pin', DAY_D);

  // The server-side squash merge: main has not moved, so the merge result
  // tree is byte-identical to the stamped tree — but GitHub mints a NEW
  // commit for it dated the next UTC day (and a squash commit is what
  // `git log -- <paths>` surfaces, unlike a TREESAME-to-a-parent merge).
  gitAt(repo, ['checkout', '-q', 'main']);
  gitAt(repo, ['merge', '-q', '--squash', 'feat/authority-change']);
  gitAt(repo, ['commit', '-q', '-m', 'feat: authority change (#1)'], DAY_D_PLUS_1);

  assert.equal(recordedAriaAuthorityHash(repo), ariaAuthorityHash(repo));
  const verdict = checkAriaAuthorityHash(repo);
  assert.equal(verdict.valid, true);
  assert.equal(verdict.reason, 'current');
  assert.equal(verdict.declared, verdict.computed);

  // Pin the motivating shape itself: this exact repository is the one the
  // retired calendar predicate rejected — the newest authority commit's UTC
  // day moved past the descriptive stamp day while the content did not.
  const lastAuthorityIso = gitAt(repo, ['log', '-1', '--format=%cI', '--', 'docs/aria']);
  const lastAuthorityDay = new Date(lastAuthorityIso).toISOString().slice(0, 10);
  assert.equal(lastAuthorityDay, DAY_D_PLUS_1_TEXT);
  assert.equal(declaredDay(repo), DAY_D_TEXT);
  assert.ok(declaredDay(repo) < lastAuthorityDay);
});

test('an authority change without a re-stamp is stale by content', () => {
  const repo = makeRepo();
  stampAtDay(repo, DAY_D_TEXT);
  commitAll(repo, 'chore: stamp the pin', DAY_D);

  writeFileSync(join(repo, 'docs/aria/SPEC.md'), '# spec\n\nv2\n');
  commitAll(repo, 'feat: authority change without a re-stamp', DAY_D_PLUS_1);

  const verdict = checkAriaAuthorityHash(repo);
  assert.equal(verdict.valid, false);
  assert.equal(verdict.reason, 'authority_hash_stale');
  assert.notEqual(verdict.declared, verdict.computed);
  assert.notEqual(recordedAriaAuthorityHash(repo), ariaAuthorityHash(repo));
});

test('a union-merge driver that lands a stale pin fails closed', () => {
  const repo = makeRepo();
  // The declared danger: a merge driver that "resolves" CURRENT_STATE by
  // concatenation can land a pin whose declared hash no longer matches the
  // merged authority content, without ever raising a conflict.
  writeFileSync(join(repo, '.gitattributes'), `${CURRENT_STATE_PATH} merge=union\n`);
  gitAt(repo, ['add', '.gitattributes']);
  gitAt(repo, ['commit', '-q', '-m', 'chore: union driver on the pin'], DAY_D);

  gitAt(repo, ['checkout', '-q', '-b', 'feat/authority-change']);
  writeFileSync(join(repo, 'docs/aria/SPEC.md'), '# spec\n\nv2\n');
  const featView = readFileSync(join(repo, CURRENT_STATE_PATH), 'utf8') + 'feat-side note\n';
  writeFileSync(join(repo, CURRENT_STATE_PATH), featView);
  commitAll(repo, 'feat: authority change with feat-side pin prose', DAY_D);

  gitAt(repo, ['checkout', '-q', 'main']);
  const mainView = readFileSync(join(repo, CURRENT_STATE_PATH), 'utf8') + 'main-side note\n';
  writeFileSync(join(repo, CURRENT_STATE_PATH), mainView);
  stampAtDay(repo, DAY_D_TEXT);
  commitAll(repo, 'chore: main-side pin prose with stamp', DAY_D);

  gitAt(repo, ['merge', '--no-ff', '--no-edit', 'feat/authority-change'], DAY_D_PLUS_1);

  const verdict = checkAriaAuthorityHash(repo);
  assert.equal(verdict.valid, false);
  assert.equal(verdict.reason, 'authority_hash_stale');
});

test('the merge-authority lane checks out the merge-result tree and runs the docs SSoT gate', () => {
  const workflow = readFileSync(MERGE_AUTHORITY_WORKFLOW, 'utf8');
  // `pull_request:` trigger with no checkout `ref:` override means
  // actions/checkout resolves refs/pull/<N>/merge — the GitHub merge-result
  // SHA — not merely the PR head.
  assert.match(workflow, /^on:\s*$/m);
  assert.match(workflow, /^  pull_request:\s*$/m);
  assert.match(workflow, /actions\/checkout@/);
  assert.doesNotMatch(workflow, /github\.event\.pull_request\.head\.sha/);
  assert.match(workflow, /npm run aria:docs:ssot/);
});

test('the CLI --check exit code mirrors the pure verdict', () => {
  const repo = makeRepo();
  stampAtDay(repo, DAY_D_TEXT);
  commitAll(repo, 'chore: stamp the pin', DAY_D);

  const cli = join(GATES_ROOT, 'aria-authority-hash.ts');
  const runCheck = (): SpawnSyncReturns<string> =>
    spawnSync(
      process.execPath,
      [
        require.resolve('ts-node/dist/bin.js'),
        '--project',
        join(GATES_ROOT, 'tsconfig.json'),
        cli,
        '--check',
      ],
      { cwd: repo, encoding: 'utf8', env: HERMETIC_GIT_ENV },
    );

  const valid = runCheck();
  assert.equal(valid.status, 0, `stdout: ${valid.stdout}\nstderr: ${valid.stderr}`);
  assert.match(valid.stdout, /aria authority hash: current \([a-f0-9]{64}\)/);

  writeFileSync(join(repo, 'docs/aria/SPEC.md'), '# spec\n\nv2\n');
  commitAll(repo, 'feat: authority change without a re-stamp', DAY_D_PLUS_1);

  const stale = runCheck();
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /STALE/);
});
