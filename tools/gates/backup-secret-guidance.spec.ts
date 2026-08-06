#!/usr/bin/env ts-node
/**
 * The backup lane's failure message has to be actionable on its own.
 *
 * `backup-production.yml` has failed on every scheduled run for months with
 * twelve unprovisioned secrets, and the message was a bare list of names. An
 * operator reading `Missing ... WALG_LIBSODIUM_KEY_B64` had to go three files
 * away to learn what that is and what shape a valid value takes — so nobody
 * did, and the failure became wallpaper. The manifest has carried a
 * plain-English `meaning` and a `safeExample` for each one the whole time.
 *
 * These tests run the real script with a deliberately incomplete environment
 * and assert the operator is told what the missing thing IS, not only that it
 * is missing. They also pin the exit code, because a helpful message attached
 * to a gate that stopped failing would be strictly worse than the wallpaper.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { test } from 'node:test';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = 'tools/scripts/database/assert-backup-secrets.sh';

/** The four SSH secrets every profile needs, so a run fails on the OTHER gaps. */
const SSH_ENV = {
  DROPLET_HOST: 'droplet.invalid',
  DROPLET_USER: 'ci',
  DROPLET_SSH_KEY: 'not-a-real-key',
  DROPLET_SSH_FINGERPRINT: 'SHA256:not-a-real-fingerprint',
};

function runScript(env: Record<string, string>): { status: number; output: string } {
  const result = spawnSync('bash', [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // A clean environment: inheriting the caller's would let a locally
    // exported secret hide the very failure under test.
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
  });
  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

void test('explains what each missing secret is, not only that it is missing', () => {
  const { status, output } = runScript({ BACKUP_SECRET_PROFILE: 'backup-runtime', ...SSH_ENV });

  assert.equal(status, 1, 'an incomplete environment must still fail the gate');
  assert.match(output, /WALG_LIBSODIUM_KEY_B64/);
  // The manifest's own words, reproduced at the point of failure.
  assert.match(output, /32-byte WAL-G client-encryption key/);
  assert.match(output, /shape: /);
});

void test('points at the runbook that says where the values come from', () => {
  const { output } = runScript({ BACKUP_SECRET_PROFILE: 'backup-runtime', ...SSH_ENV });

  assert.match(output, /docs\/runbooks\/secret-rotation\.md/);
});

void test('still fails on a missing non-secret coordinate, with the same guidance', () => {
  // Variables are a separate failure path in the script and had the same bare
  // list; a fix that only covered secrets would leave half the gap open.
  const { status, output } = runScript({
    BACKUP_SECRET_PROFILE: 'backup-runtime',
    ...SSH_ENV,
    SPACES_ENDPOINT: 'https://example.invalid',
    SPACES_REGION: 'fra1',
    BACKUP_POSTGRES_USER: 'x',
    BACKUP_POSTGRES_DB: 'x',
    BACKUP_POSTGRES_PASSWORD: 'x',
    WALG_SPACES_ACCESS_KEY_ID: 'x',
    WALG_SPACES_SECRET_ACCESS_KEY: 'x',
    WALG_LIBSODIUM_KEY_B64: 'x',
    LOGICAL_BACKUP_SPACES_BUCKET: 'x',
    LOGICAL_BACKUP_SPACES_ACCESS_KEY_ID: 'x',
    LOGICAL_BACKUP_SPACES_SECRET_ACCESS_KEY: 'x',
    LOGICAL_BACKUP_GPG_RECIPIENT: 'x',
  });

  assert.equal(status, 1);
  assert.match(output, /WALG_SPACES_BUCKET/);
  assert.match(output, /bucket coordinate/i);
});

void test('says nothing extra when the environment is complete', () => {
  // The archive-freshness profile needs only the four SSH secrets, which makes
  // it the one profile this test can satisfy honestly without inventing
  // credentials. A guidance block printed on success would be noise.
  const { status, output } = runScript({ BACKUP_SECRET_PROFILE: 'archive-freshness', ...SSH_ENV });

  assert.equal(status, 0);
  assert.doesNotMatch(output, /docs\/runbooks\/secret-rotation\.md/);
});
