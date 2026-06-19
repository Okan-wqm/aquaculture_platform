import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { commitHasFindingCloseTrailer, commitMessageClosesFinding } from './finding-traceability';

const repo = mkdtempSync(join(tmpdir(), 'finding-traceability-spec-'));
const HERMETIC_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);

function git(args: readonly string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: HERMETIC_ENV,
  }).trim();
}

git(['init', '--quiet', '--initial-branch=main']);
git(['config', 'user.email', 'spec@invalid.local']);
git(['config', 'user.name', 'finding-traceability-spec']);

writeFileSync(join(repo, 'closed.txt'), 'closed\n');
git(['add', 'closed.txt']);
git([
  'commit',
  '--quiet',
  '--no-verify',
  '-m',
  'fix(database): close finding',
  '-m',
  'Closes: docs/reviews/data-expert/review.md#INFRA-CRITICAL-009',
]);
const closingCommit = git(['rev-parse', 'HEAD']);

writeFileSync(join(repo, 'merge.txt'), 'merge\n');
git(['add', 'merge.txt']);
git(['commit', '--quiet', '--no-verify', '-m', 'Merge pull request #549 from feature']);
const trailerlessCommit = git(['rev-parse', 'HEAD']);

void after(() => {
  rmSync(repo, { recursive: true, force: true });
});

void test('commitMessageClosesFinding accepts anchor, bare, and backlog trailers', () => {
  assert.equal(
    commitMessageClosesFinding(
      'body\n\nCloses: docs/reviews/x.md#INFRA-CRITICAL-009\n',
      'INFRA-CRITICAL-009',
    ),
    true,
  );
  assert.equal(
    commitMessageClosesFinding('Closes: INFRA-CRITICAL-009\n', 'INFRA-CRITICAL-009'),
    true,
  );
  assert.equal(
    commitMessageClosesFinding('Closes: BACKLOG-EDGE-001\n', 'INFRA-CRITICAL-009'),
    true,
  );
});

void test('commitMessageClosesFinding rejects non-matching and missing trailers', () => {
  assert.equal(
    commitMessageClosesFinding('Closes: INFRA-CRITICAL-010\n', 'INFRA-CRITICAL-009'),
    false,
  );
  assert.equal(
    commitMessageClosesFinding('Merge pull request #549 from feature\n', 'INFRA-CRITICAL-009'),
    false,
  );
});

void test('commitHasFindingCloseTrailer reads git commit messages and fails closed', () => {
  assert.equal(commitHasFindingCloseTrailer(repo, closingCommit, 'INFRA-CRITICAL-009').ok, true);

  const result = commitHasFindingCloseTrailer(repo, trailerlessCommit, 'INFRA-CRITICAL-009');
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /does not contain a Closes: trailer/);
});
