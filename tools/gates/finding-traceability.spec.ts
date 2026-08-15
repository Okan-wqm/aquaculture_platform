import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  commitHasFindingCloseTrailer,
  commitMessageClosesFinding,
  parseCommitObservationBatch,
  readCommitObservations,
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

void test('readCommitObservations returns one ordered frozen existence and message snapshot', () => {
  const missingCommit = '0000000000000000000000000000000000000000';
  const observations = readCommitObservations(repo, [
    trailerlessCommit,
    missingCommit,
    closingCommit,
  ]);

  assert.equal(Object.isFrozen(observations), true);
  assert.deepEqual(
    observations.map(({ exists, oid, resolvedOid }) => ({ exists, oid, resolvedOid })),
    [
      { exists: true, oid: trailerlessCommit, resolvedOid: trailerlessCommit },
      { exists: false, oid: missingCommit, resolvedOid: null },
      { exists: true, oid: closingCommit, resolvedOid: closingCommit },
    ],
  );
  assert.match(observations[0]?.message ?? '', /Merge pull request #549/);
  assert.equal(observations[1]?.message, null);
  assert.match(observations[2]?.message ?? '', /INFRA-CRITICAL-009/);
  assert.equal(observations.every(Object.isFrozen), true);
});

void test('readCommitObservations rejects duplicate identities before opening Git', () => {
  assert.throws(
    () => readCommitObservations(repo, [closingCommit, closingCommit]),
    /duplicate object IDs/,
  );
});

function commitBatchRecord(resolvedOid: string, message: Buffer): Buffer {
  const content = Buffer.concat([
    Buffer.from(
      `tree 1111111111111111111111111111111111111111\nauthor Spec <spec@example.invalid> 0 +0000\ncommitter Spec <spec@example.invalid> 0 +0000\n\n`,
      'ascii',
    ),
    message,
  ]);
  return Buffer.concat([
    Buffer.from(`${resolvedOid} commit ${String(content.length)}\n`, 'ascii'),
    content,
    Buffer.from('\n', 'ascii'),
  ]);
}

void test('commit observation parser rejects ambiguous, truncated, trailing, and non-UTF-8 frames', () => {
  const requestedOid = 'abcdef0';
  const resolvedOid = 'abcdef0123456789abcdef0123456789abcdef01';
  const valid = commitBatchRecord(resolvedOid, Buffer.from('valid message\n'));

  assert.throws(
    () =>
      parseCommitObservationBatch(
        [requestedOid],
        Buffer.from(`${requestedOid}^{commit} ambiguous\n`),
      ),
    /invalid header/,
  );
  assert.throws(
    () => parseCommitObservationBatch([requestedOid], valid.subarray(0, valid.length - 1)),
    /truncated content/,
  );
  assert.throws(
    () => parseCommitObservationBatch([requestedOid], Buffer.concat([valid, Buffer.from('x')])),
    /unconsumed trailing bytes/,
  );
  assert.throws(
    () =>
      parseCommitObservationBatch(
        [requestedOid],
        commitBatchRecord(resolvedOid, Buffer.from([0xff])),
      ),
    /non-UTF-8 message/,
  );
});
