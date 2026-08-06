#!/usr/bin/env ts-node
/**
 * The renderer is the last thing standing between an alert and nobody.
 *
 * Its predecessor demanded three webhook endpoints that were never procured
 * and hard-failed without them, so no deploy path could call it, so
 * alertmanager has spent months pointed at 127.0.0.1:9099 with nothing
 * listening. That failure was invisible because the script had no test: a
 * renderer nobody can run looks identical to a renderer nobody needed.
 *
 * These run the real script against a copy of the real config and assert the
 * two things that decide whether an alert arrives: every placeholder is gone,
 * and no partially-rendered config is ever left behind.
 */

import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts/monitoring/render-configs.sh');
const COMMITTED = join(REPO_ROOT, 'infrastructure/monitoring/droplet/alertmanager.yml');

const GOOD_ENV = {
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '587',
  SMTP_USER: 'alerts-bot',
  SMTP_PASSWORD: 'not-a-real-password',
  SMTP_FROM: 'alerts@example.com',
  ALERT_PAGE_EMAIL_TO: 'ops@example.com',
};

function render(env: Record<string, string>): { status: number; stderr: string; config: string } {
  const dir = mkdtempSync(join(tmpdir(), 'am-render-'));
  const target = join(dir, 'alertmanager.yml');
  copyFileSync(COMMITTED, target);
  try {
    const result = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ALERTMANAGER_CONFIG_PATH: target, ...env },
    });
    return {
      status: result.status ?? -1,
      stderr: `${result.stderr}${result.stdout}`,
      config: readFileSync(target, 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

void test('the committed config carries no real address and no real credential', () => {
  // The whole placeholder discipline rests on this: `.invalid` is reserved by
  // RFC 2606 and can never resolve, so an unrendered config cannot deliver.
  const committed = readFileSync(COMMITTED, 'utf8');

  assert.match(committed, /page@example\.invalid/);
  assert.match(committed, /digest@example\.invalid/);
  assert.match(committed, /smtp\.invalid:587/);
  assert.match(committed, /REPLACE_SMTP_PASSWORD/);
});

void test('a full render leaves no placeholder behind', () => {
  const { status, config } = render(GOOD_ENV);

  assert.equal(status, 0);
  assert.doesNotMatch(config, /example\.invalid/);
  assert.doesNotMatch(config, /REPLACE_SMTP/);
  assert.match(config, /smtp\.example\.com:587/);
  assert.match(config, /to: 'ops@example\.com'/);
});

void test('digest falls back to the page mailbox but stays a separate knob', () => {
  // Role routing is the stated next step; the seam has to exist before it.
  const both = render(GOOD_ENV).config;
  assert.equal(both.match(/to: 'ops@example\.com'/g)?.length, 2);

  const split = render({ ...GOOD_ENV, ALERT_DIGEST_EMAIL_TO: 'digest@example.com' }).config;
  assert.match(split, /to: 'ops@example\.com'/);
  assert.match(split, /to: 'digest@example\.com'/);
});

void test('refuses to run without the delivery settings, rather than rendering half a config', () => {
  for (const missing of [
    'SMTP_HOST',
    'SMTP_USER',
    'SMTP_PASSWORD',
    'SMTP_FROM',
    'ALERT_PAGE_EMAIL_TO',
  ]) {
    const env: Record<string, string> = { ...GOOD_ENV };
    delete env[missing];
    const { status, config } = render(env);

    assert.equal(status, 1, `${missing} must be required`);
    // Nothing may have been substituted: a config with real SMTP settings and
    // a placeholder recipient is worse than one that never started.
    assert.match(config, /example\.invalid/, `${missing}: config must be untouched`);
  }
});

void test('rejects a recipient that is still a placeholder', () => {
  const { status } = render({ ...GOOD_ENV, ALERT_PAGE_EMAIL_TO: 'page@example.invalid' });

  assert.equal(status, 1);
});

void test('says out loud that the deadman is unwired instead of leaving a loopback that reads like config', () => {
  const { stderr, config } = render(GOOD_ENV);

  assert.match(stderr, /deadman is not wired/);
  // The heartbeat webhook is deliberately left alone — a mailbox receiving
  // nothing looks exactly like a mailbox nobody sent to, so email cannot play
  // the deadman's role.
  assert.match(config, /127\.0\.0\.1:9099\/heartbeat/);
});

void test('wires the deadman when an endpoint is supplied', () => {
  const { stderr, config } = render({
    ...GOOD_ENV,
    ALERTMANAGER_HEARTBEAT_URL: 'https://dead.example.com/ping',
  });

  assert.match(stderr, /heartbeat deadman wired/);
  assert.doesNotMatch(config, /127\.0\.0\.1:9099\/heartbeat/);
});

void test('is idempotent — a second run changes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'am-render-idem-'));
  const target = join(dir, 'alertmanager.yml');
  copyFileSync(COMMITTED, target);
  try {
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      ALERTMANAGER_CONFIG_PATH: target,
      ...GOOD_ENV,
    };
    execFileSync('bash', [SCRIPT], { env, encoding: 'utf8' });
    const first = readFileSync(target, 'utf8');
    execFileSync('bash', [SCRIPT], { env, encoding: 'utf8' });

    assert.equal(readFileSync(target, 'utf8'), first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
