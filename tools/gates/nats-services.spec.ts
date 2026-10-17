#!/usr/bin/env ts-node
/**
 * tools/gates/nats-services.ts — the one tool-side reader of infrastructure/nats/services.yaml
 * (ARIA-MEDIUM-314).
 *
 * The live cases compare the reader with an independent raw `yaml.parse` of the same file, so a
 * reader that drops items (the defect class: a quoted-only list-item regex parsed nothing once the
 * SSoT dropped its quotes) cannot pass by looping over nothing.
 *
 * Invoke via:
 *   ts-node --project tools/gates/tsconfig.json tools/gates/nats-services.spec.ts
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';

import { parse as yamlParse } from 'yaml';

import {
  aclEventRipple,
  eventSubjectsFor,
  filtersOverlap,
  loadNatsServices,
  NATS_SERVICES_YAML,
  type NatsServiceEntry,
  NatsServicesInvalid,
  parseNatsServices,
  subjectMatches,
} from './nats-services';

const REPO_ROOT = resolve(__dirname, '..', '..');
const parseYaml: (input: string) => unknown = yamlParse;

interface RawService {
  readonly name: string;
  readonly application: string;
  readonly publish: readonly string[];
  readonly subscribe: readonly string[];
}

/** The live SSoT read without the module under test. */
function rawServices(): RawService[] {
  const document = parseYaml(readFileSync(join(REPO_ROOT, NATS_SERVICES_YAML), 'utf8'));
  assert.ok(typeof document === 'object' && document !== null && 'services' in document);
  const services: unknown = document.services;
  assert.ok(Array.isArray(services));
  return services.map((entry: unknown): RawService => {
    assert.ok(typeof entry === 'object' && entry !== null);
    const record = entry as Record<string, unknown>;
    const list = (key: string): string[] => {
      const value = record[key];
      assert.ok(Array.isArray(value));
      return value.map(String);
    };
    return {
      name: String(record['name']),
      application: String(record['application']),
      publish: list('publish'),
      subscribe: list('subscribe'),
    };
  });
}

function service(overrides: Partial<NatsServiceEntry> & { name: string }): NatsServiceEntry {
  return {
    application: overrides.name.replace(/_/g, '-'),
    description: 'a fixture service',
    publish: ['$JS.API.INFO', '_INBOX.>', '$JS.ACK.>'],
    subscribe: ['_INBOXFIXTURE.>', 'commands.fixture.ping'],
    ...overrides,
  };
}

const MINIMAL = (name: string, application: string, extraPublish = '  - events.*.Probe'): string =>
  [
    'version: 1',
    'services:',
    `- name: ${name}`,
    `  application: ${application}`,
    '  description: a fixture service',
    '  publish:',
    extraPublish,
    '  - $JS.API.INFO',
    '  - _INBOX.>',
    '  subscribe:',
    '  - "events.*.Other"',
    '  - _INBOXFIXTURE.>',
    '',
  ].join('\n');

void test('the live services.yaml loads whole: every service, every grant, each with its application', () => {
  const raw = rawServices();
  const loaded = loadNatsServices();
  assert.ok(raw.length > 0);
  assert.deepEqual(
    loaded.map(({ name, application, publish, subscribe }) => ({
      name,
      application,
      publish,
      subscribe,
    })),
    raw,
  );
  for (const entry of loaded)
    assert.ok(entry.application.length > 0, `${entry.name} has no application`);
});

void test('quoted and unquoted list items parse identically', () => {
  const unquoted = parseNatsServices(MINIMAL('fixture_service', 'fixture-service'));
  const quoted = parseNatsServices(
    MINIMAL('fixture_service', 'fixture-service').replace('- events.*.Probe', '- "events.*.Probe"'),
  );
  assert.deepEqual(quoted, unquoted);
  assert.equal(unquoted[0]?.publish[0], 'events.*.Probe');
  assert.equal(unquoted[0]?.subscribe[0], 'events.*.Other');
});

void test('a document the SSoT schema refuses throws NatsServicesInvalid', () => {
  const withoutApplication = MINIMAL('fixture_service', 'fixture-service').replace(
    '  application: fixture-service\n',
    '',
  );
  assert.throws(() => parseNatsServices(withoutApplication), NatsServicesInvalid);
  const unknownKey = MINIMAL('fixture_service', 'fixture-service').replace(
    '  description:',
    '  owner: someone\n  description:',
  );
  assert.throws(() => parseNatsServices(unknownKey), NatsServicesInvalid);
  const lostGrants = MINIMAL('fixture_service', 'fixture-service').replace(
    / {2}publish:\n(?: {2}- .*\n)+/,
    '  publish: []\n',
  );
  assert.throws(() => parseNatsServices(lostGrants), NatsServicesInvalid);
  assert.throws(() => parseNatsServices('services: [unclosed'), NatsServicesInvalid);
  assert.throws(() => loadNatsServices('/nonexistent/services.yaml'), NatsServicesInvalid);
});

void test('subjectMatches follows NATS semantics: whole tokens, `>` last and at least one token', () => {
  const table: [string, string, boolean][] = [
    ['events.>', 'events.t1.UserInvited', true],
    ['events.>', 'events', false],
    ['events.*.UserInvited', 'events.t1.UserInvited', true],
    ['events.*.UserInvited', 'events.t1.UserDeleted', false],
    ['events.*', 'events.t1.UserInvited', false],
    ['events.*.UserInvited', 'events.UserInvited', false],
    ['Farm*', 'FarmCreated', false],
    ['events.a..b', 'events.a..b', false],
    ['events.>', 'events.', false],
    ['events.>.x', 'events.a.x', false],
    ['request.farm.validate', 'request.farm.validate', true],
  ];
  for (const [filter, subject, expected] of table) {
    assert.equal(subjectMatches(filter, subject), expected, `${filter} vs ${subject}`);
  }
});

void test('filtersOverlap is true exactly when some concrete subject matches both filters', () => {
  const table: [string, string, boolean][] = [
    ['events.>', 'events.*.UserInvited', true],
    ['events.*.UserInvited', 'events.>', true],
    ['events.*.UserInvited', 'events.*.UserDeleted', false],
    ['events.>', 'events', false],
    ['telemetry.>', 'events.*.SensorReading', false],
    ['events.*.*', 'events.t1.UserInvited', true],
    ['events.*', 'events.*.UserInvited', false],
  ];
  for (const [left, right, expected] of table) {
    assert.equal(filtersOverlap(left, right), expected, `${left} vs ${right}`);
  }
});

void test('eventSubjectsFor takes declared grants, else the default events root', () => {
  const live = loadNatsServices();
  assert.deepEqual(eventSubjectsFor('UserInvited', live), {
    subjects: ['events.*.UserInvited'],
    source: 'declared',
  });
  assert.deepEqual(eventSubjectsFor('NoSuchEventType', live), {
    subjects: ['events.*.NoSuchEventType'],
    source: 'default_root',
  });
});

void test('every event type a live publish grant names has a producer, from an independent token read', () => {
  const raw = rawServices();
  const tokens = new Set<string>();
  for (const entry of raw) {
    for (const grant of entry.publish) {
      const match = /^(?:events|telemetry)\.\*\.([A-Z][A-Za-z0-9]*)$/.exec(grant);
      if (match?.[1]) tokens.add(match[1]);
    }
  }
  assert.ok(tokens.size > 0, 'the live SSoT grants event publishes');
  const live = loadNatsServices();
  for (const token of tokens) {
    assert.ok(aclEventRipple(token, live).producers.length >= 1, `${token} has no producer`);
  }
  const invited = aclEventRipple('UserInvited', live).producers.map(({ service: s }) => [
    s.name,
    s.application,
  ]);
  assert.deepEqual(invited, [['auth_service', 'auth-service']]);
});

void test('a grant that admits the event only through wildcards is catch-all; one naming it is not', () => {
  const services = [
    service({
      name: 'publisher_service',
      publish: ['events.*.UserInvited', '$JS.API.INFO', '_INBOX.>'],
    }),
    service({ name: 'catchall_service', subscribe: ['events.>', '_INBOXCATCHALL.>'] }),
    service({ name: 'explicit_service', subscribe: ['events.>', 'events.*.UserInvited'] }),
  ];
  const ripple = aclEventRipple('UserInvited', services);
  assert.deepEqual(
    ripple.aclSubscribers.map(({ service: s, grant, catchAll }) => [s.name, grant, catchAll]),
    [
      ['catchall_service', 'events.>', true],
      // The explicit grant wins over the catch-all one on the same service.
      ['explicit_service', 'events.*.UserInvited', false],
    ],
  );
  assert.deepEqual(
    ripple.producers.map(({ service: s }) => s.name),
    ['publisher_service'],
  );
});

/** Tool sources outside node_modules, fixtures and specs. */
function toolSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'fixtures') continue;
    if (statSync(path).isDirectory()) out.push(...toolSources(path));
    else if (/\.(ts|mts|mjs|js)$/.test(name) && !/\.(spec|test)\.[mc]?[jt]s$/.test(name))
      out.push(path);
  }
  return out;
}

void test('no tool outside this module names the services.yaml path, so no tool reads it privately', () => {
  // A string literal whose whole content is a path ending in services.yaml, or a path join
  // ending in that segment: the shape of every private reader this module replaced. Prose that
  // mentions the file inside a longer string does not match.
  const pathLiteral = /(['"`])[\w./-]*services\.yaml\1|,\s*(['"`])services\.yaml\2\s*\)/;
  const flagged = toolSources(join(REPO_ROOT, 'tools'))
    .filter((path) => {
      const code = readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      return pathLiteral.test(code);
    })
    .map((path) => relative(REPO_ROOT, path))
    .sort();
  assert.deepEqual(flagged, ['tools/gates/nats-services.ts']);
});
