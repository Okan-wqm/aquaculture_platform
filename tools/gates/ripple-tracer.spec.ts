#!/usr/bin/env ts-node
/**
 * tools/ripple-tracer/cli.ts against the live NATS SSoT (ARIA-MEDIUM-314).
 *
 * The tracer kept a private services.yaml parser that accepted only quoted list items and a
 * default subject in the retired `AQUACULTURE_EVENTS.<T>.>` namespace: for UserInvited it reported
 * no producer and no subscriber (exit 1), and with `--subject events.*.UserInvited` still nothing.
 * It now reads the SSoT through tools/gates/nats-services.ts. The cases run the CLI as a
 * subprocess through its own tsconfig, exactly as `npm run ripple` does.
 *
 * Invoke via:
 *   ts-node --project tools/gates/tsconfig.json tools/gates/ripple-tracer.spec.ts
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

import { eventConsumersFor, scanEventConsumers } from './event-consumer-index';
import { loadNatsServices } from './nats-services';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CLI = join(REPO_ROOT, 'tools', 'ripple-tracer', 'cli.ts');
const TSCONFIG = join(REPO_ROOT, 'tools', 'ripple-tracer', 'tsconfig.json');
const scratch = mkdtempSync(join(tmpdir(), 'ripple-tracer-spec-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

interface GrantJson {
  name: string;
  application: string;
  grant: string;
  subject: string;
  catch_all: boolean;
}

interface ConsumerJson {
  application: string;
  sources: string[];
  code_sites: string[];
  grant: string | null;
  subject: string;
}

interface TracerJson {
  event_type: string;
  subjects: string[];
  subject_source: string;
  yaml_service_count: number;
  producers: GrantJson[];
  acl_subscribers: GrantJson[];
  consumer_source: string;
  consumers: ConsumerJson[];
  acl_catch_all: GrantJson[];
  unresolved: { application: string | null; site: string; api: string; form: string }[];
}

function tracer(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    join(REPO_ROOT, 'node_modules', '.bin', 'ts-node'),
    ['--project', TSCONFIG, CLI, ...args],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

void test('UserInvited: the declared subject, auth-service as producer, exit 0', () => {
  const run = tracer('--event', 'UserInvited', '--format', 'json');
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout) as TracerJson;
  assert.deepEqual(report.subjects, ['events.*.UserInvited']);
  assert.equal(report.subject_source, 'declared');
  assert.ok(report.yaml_service_count > 0);
  assert.deepEqual(
    report.producers.map((p) => [p.name, p.application, p.grant]),
    [['auth_service', 'auth-service', 'events.*.UserInvited']],
  );
  // Every subscriber is named by its application as well as its identity, and says whether
  // its grant names the event or only admits it through wildcards.
  for (const subscriber of report.acl_subscribers) {
    assert.ok(subscriber.application.length > 0);
    assert.equal(typeof subscriber.catch_all, 'boolean');
  }
});

void test('an override subject nobody publishes on has no producer: exit 1', () => {
  const run = tracer(
    '--event',
    'UserInvited',
    '--subject',
    'events.*.NoSuchEventType',
    '--format',
    'json',
  );
  assert.equal(run.status, 1);
  const report = JSON.parse(run.stdout) as TracerJson;
  assert.equal(report.subject_source, 'override');
  assert.deepEqual(report.producers, []);
});

void test('an event type no grant names falls back to the default events root: exit 1', () => {
  const run = tracer('--event', 'NoSuchEventType', '--format', 'json');
  assert.equal(run.status, 1);
  const report = JSON.parse(run.stdout) as TracerJson;
  assert.deepEqual(report.subjects, ['events.*.NoSuchEventType']);
  assert.equal(report.subject_source, 'default_root');
});

void test('a services.yaml its schema refuses is exit 3; a usage error is exit 2', () => {
  const invalid = join(scratch, 'services.yaml');
  writeFileSync(invalid, 'version: 1\nservices:\n- name: x\n', 'utf8');
  assert.equal(tracer('--event', 'UserInvited', '--services-yaml', invalid).status, 3);
  assert.equal(tracer('--services-yaml', invalid).status, 2);
  assert.equal(tracer('--event', 'UserInvited', '--format', 'xml').status, 2);
});

void test('the Markdown report names the producer and says what an ACL grant proves', () => {
  const run = tracer('--event', 'UserInvited');
  assert.equal(run.status, 0, run.stderr);
  assert.match(
    run.stdout,
    /\*\*Producer\(s\)\*\*: `auth-service` \(`auth_service`, `events\.\*\.UserInvited`\)/,
  );
  assert.match(run.stdout, /a permission, not evidence that the service consumes the event/);
});

void test('ARIA-HIGH-313: consumers are the code subscriptions and naming grants, the witness set', () => {
  const run = tracer('--event', 'UserInvited', '--format', 'json');
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout) as TracerJson;
  assert.equal(report.consumer_source, 'code_subscriptions+acl_grants');
  // The same consumer set the plan-coverage witness uses: one function owns it.
  const expected = eventConsumersFor(
    'UserInvited',
    scanEventConsumers(REPO_ROOT),
    loadNatsServices(),
  );
  assert.deepEqual(
    report.consumers.map((c) => [c.application, c.sources, c.code_sites]),
    expected.consumers.map((c) => [c.application, c.sources, c.codeSites]),
  );
  const notification = report.consumers.find((c) => c.application === 'notification-service');
  assert.ok(notification !== undefined, 'the durable UserInvited consumer is listed');
  assert.ok(
    notification.code_sites.some((site) =>
      site.startsWith(
        'apps/notification-service/src/notification/event-handlers/auth-event.handler.ts:',
      ),
    ),
  );
  // Catch-all grants are listed apart, as permissions.
  for (const grant of report.acl_catch_all) assert.equal(grant.catch_all, true);
  assert.deepEqual(report.unresolved, []);
});

void test('ARIA-HIGH-313: the Markdown dispatch checklist names each consumer with its code sites', () => {
  const run = tracer('--event', 'UserInvited');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /- \[ \] Dispatch review to the agent owning `notification-service`/);
  assert.match(run.stdout, /auth-event\.handler\.ts:\d+/);
});
