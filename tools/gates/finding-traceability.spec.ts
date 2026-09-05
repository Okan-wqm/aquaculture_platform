import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  applyClosureRejection,
  collectMergedClosures,
  type Finding,
  listMergedClosers,
} from './finding-registry';
import {
  closureAdmissible,
  commitHasFindingCloseTrailer,
  commitMessageClosesFinding,
  commitMessageClosesFindingExactly,
  findingRejectsClosure,
} from './finding-traceability';

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

void test('commitMessageClosesFindingExactly binds the id and the anchored review file', () => {
  const finding = { id: 'INFRA-CRITICAL-009', review_file: 'docs/reviews/data-expert/review.md' };
  assert.equal(
    commitMessageClosesFindingExactly(
      'fix: x\n\nCloses: docs/reviews/data-expert/review.md#INFRA-CRITICAL-009\n',
      finding,
    ),
    true,
  );
  assert.equal(
    commitMessageClosesFindingExactly('fix: x\n\nCloses: INFRA-CRITICAL-009\n', finding),
    true,
    'a bare id trailer still closes',
  );
  assert.equal(
    commitMessageClosesFindingExactly(
      'fix: x\n\nCloses: docs/reviews/other/older-epoch.md#INFRA-CRITICAL-009\n',
      finding,
    ),
    false,
    'an anchor naming another review file is a different finding that reused the id',
  );
  assert.equal(
    commitMessageClosesFindingExactly('fix: x\n\nCloses: BACKLOG-NATS-002\n', finding),
    false,
    'a backlog trailer closes no registry finding',
  );
  assert.equal(
    commitMessageClosesFindingExactly('fix: x\n\nCloses: docs/r.md#INFRA-CRITICAL-0090\n', finding),
    false,
    'ids match on word boundaries',
  );
});

void test('a closer rejected by an override reopen is refused by admission and skipped by derivation', () => {
  const finding = {
    id: 'INFRA-CRITICAL-009',
    review_file: 'docs/reviews/data-expert/review.md',
    rejected_closing_commits: [closingCommit.slice(0, 12)],
  };
  assert.equal(findingRejectsClosure(finding, closingCommit), true, 'prefix and full SHA match');
  assert.equal(findingRejectsClosure(finding, trailerlessCommit), false);
  assert.equal(findingRejectsClosure({ id: finding.id }, closingCommit), false, 'no rejections');

  const refused = closureAdmissible(finding, closingCommit);
  assert.equal(refused.ok, false);
  assert.match(refused.reason ?? '', /rejected as a closer .* override reopen/);
  assert.equal(closureAdmissible({ id: finding.id }, closingCommit).ok, true);

  // The same commit closes the finding when nothing rejected it, and closes
  // nothing once the override reopen has: derivation must not re-close a
  // finding from the very commit the reopen judged insufficient.
  assert.deepEqual(
    collectMergedClosures(repo, 'main', [{ id: finding.id, review_file: finding.review_file }]),
    [{ findingId: finding.id, sha: closingCommit }],
  );
  assert.deepEqual(collectMergedClosures(repo, 'main', [finding]), []);
});

void test('applyClosureRejection moves every closer to rejected_closing_commits and reopens', () => {
  const base = {
    id: 'INFRA-CRITICAL-009',
    severity: 'CRITICAL' as const,
    title: 'x',
    owner_agent: 'infra-expert',
    raised_in_cycle: 'spec',
    created_at: '2026-01-01T00:00:00Z',
    deadline: null,
    owner_user: null,
    override_of: null,
    prev_hash: '0'.repeat(64),
    content_hash: '0'.repeat(64),
  };
  const resolved = (): Finding => ({
    ...base,
    state: 'RESOLVED',
    closed_at: '2026-02-01T00:00:00Z',
    closing_commits: [closingCommit, trailerlessCommit],
    notes: 'n',
  });

  const entry = resolved();
  const ok = applyClosureRejection(entry, {
    shas: [closingCommit.slice(0, 7), trailerlessCommit],
    reason: 'aliases still present',
    now: '2026-09-04T10:00:00Z',
  });
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(entry.state, 'OPEN');
  assert.equal(entry.closed_at, null);
  assert.deepEqual(entry.closing_commits, []);
  assert.deepEqual(entry.rejected_closing_commits, [closingCommit, trailerlessCommit]);
  assert.match(
    entry.notes ?? '',
    /\[override reopen 2026-09-04: closer .* rejected — aliases still present\]/,
  );

  const partial = applyClosureRejection(resolved(), { shas: [closingCommit], reason: 'r' });
  assert.equal(partial.ok, false);
  assert.match(partial.reason ?? '', /would still be closed by/);

  const unreasoned = applyClosureRejection(resolved(), { shas: [closingCommit], reason: '  ' });
  assert.equal(unreasoned.ok, false);
  assert.match(unreasoned.reason ?? '', /requires --reason/);

  const empty = applyClosureRejection(resolved(), { shas: [], reason: 'r' });
  assert.equal(empty.ok, false);
  assert.match(empty.reason ?? '', /at least one --reject-closure/);

  // A closer the ceremony never recorded (the derivation would still find it on
  // main) can be rejected too, and an already-open row stays open: the
  // decision is about the commit, not the row's current state.
  const open: Finding = { ...base, state: 'OPEN', closed_at: null, closing_commits: [] };
  const rejectedOnOpen = applyClosureRejection(open, { shas: [trailerlessCommit], reason: 'r' });
  assert.equal(rejectedOnOpen.ok, true, rejectedOnOpen.reason);
  assert.equal(open.state, 'OPEN');
  assert.deepEqual(open.rejected_closing_commits, [trailerlessCommit]);

  const stale: Finding = { ...base, state: 'STALE', closed_at: null, closing_commits: [] };
  assert.equal(applyClosureRejection(stale, { shas: [closingCommit], reason: 'r' }).ok, false);
});

void test('listMergedClosers returns every unrejected closer on the ref, oldest first', () => {
  writeFileSync(join(repo, 'again.txt'), 'again\n');
  git(['add', 'again.txt']);
  git([
    'commit',
    '--quiet',
    '--no-verify',
    '-m',
    'fix(database): close it again',
    '-m',
    'Closes: docs/reviews/data-expert/review.md#INFRA-CRITICAL-009',
  ]);
  const secondCloser = git(['rev-parse', 'HEAD']);
  const finding = { id: 'INFRA-CRITICAL-009', review_file: 'docs/reviews/data-expert/review.md' };

  assert.deepEqual(listMergedClosers(repo, 'main', finding), [closingCommit, secondCloser]);
  assert.deepEqual(
    listMergedClosers(repo, 'main', { ...finding, rejected_closing_commits: [closingCommit] }),
    [secondCloser],
    'rejecting only the oldest closer leaves the finding closable by the next one',
  );
  assert.deepEqual(
    listMergedClosers(repo, 'main', {
      ...finding,
      rejected_closing_commits: [closingCommit, secondCloser],
    }),
    [],
  );
  // The oldest-wins derivation moves on to the next unrejected closer.
  assert.deepEqual(
    collectMergedClosures(repo, 'main', [
      { ...finding, rejected_closing_commits: [closingCommit] },
    ]),
    [{ findingId: finding.id, sha: secondCloser }],
  );
});
