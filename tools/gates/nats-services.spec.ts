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
  loadNatsServicesLocated,
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

void test('the located read cites the line of every live identity and grant', () => {
  // SE-3: a fact citing services.yaml cites the line it came from. The oracle is the raw text.
  const lines = readFileSync(join(REPO_ROOT, NATS_SERVICES_YAML), 'utf8').split('\n');
  const located = loadNatsServicesLocated(join(REPO_ROOT, NATS_SERVICES_YAML));
  assert.deepEqual(located.services, loadNatsServices());
  const textAt = (line: number | undefined): string => lines[(line ?? 0) - 1] ?? '';
  for (const service of located.services) {
    const at = located.lines.get(service.name);
    assert.ok(at, `${service.name} has source lines`);
    assert.match(textAt(at.name), new RegExp(`name:\\s*['"]?${service.name}['"]?\\s*$`));
    for (const permission of ['publish', 'subscribe'] as const) {
      assert.equal(
        at[permission].length,
        service[permission].length,
        `${service.name}.${permission}`,
      );
      service[permission].forEach((grant, index) => {
        assert.ok(textAt(at[permission][index]).includes(grant), `${service.name} ${grant}`);
      });
    }
  }
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

// ARIA-LOW-603 — what a valid document holds beyond its schema. The messaging ACL smoke checked
// these on its own private parse; the reader owns them now, so every consumer gets them.
const TWO_SERVICES = (second: string, secondApplication: string): string =>
  MINIMAL('fixture_service', 'fixture-service') +
  MINIMAL(second, secondApplication)
    .split('\n')
    .filter((line) => line !== 'version: 1' && line !== 'services:')
    .join('\n');

void test('two entries for one identity, or for one application, throw NatsServicesInvalid', () => {
  assert.doesNotThrow(() => parseNatsServices(TWO_SERVICES('other_service', 'other-service')));
  assert.throws(
    () => parseNatsServices(TWO_SERVICES('fixture_service', 'other-service')),
    (error: unknown) =>
      error instanceof NatsServicesInvalid &&
      /duplicate service fixture_service/.test(error.message),
  );
  assert.throws(
    () => parseNatsServices(TWO_SERVICES('other_service', 'fixture-service')),
    (error: unknown) =>
      error instanceof NatsServicesInvalid &&
      /duplicate application fixture-service/.test(error.message),
  );
});

void test('a grant listed twice in one permission throws NatsServicesInvalid', () => {
  const repeated = MINIMAL('fixture_service', 'fixture-service', '  - _INBOX.>');
  assert.throws(
    () => parseNatsServices(repeated),
    (error: unknown) =>
      error instanceof NatsServicesInvalid &&
      /fixture_service\.publish repeats _INBOX\.>/.test(error.message),
  );
});

for (const [malformed, rule] of [
  ['events.foo..bar', /empty NATS subject token/],
  ['events.foo*bar', /partial NATS subject wildcard token/],
  ['request.>.x', /NATS subject wildcard before the final token/],
] as const) {
  void test(`a grant that is not a NATS subject (${malformed}) throws NatsServicesInvalid`, () => {
    // The schema's character class admits each of these; the broker does not.
    const document = MINIMAL('fixture_service', 'fixture-service', `  - ${malformed}`);
    assert.throws(
      () => parseNatsServices(document),
      (error: unknown) => error instanceof NatsServicesInvalid && rule.test(error.message),
    );
  });
}

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

// SE-3-R2 round 2 (build/SE-3-R2/appellate-r2.md, carried security A1): the code-fact bridge
// carries this message into the kernel's witness stderr_tail, so a syntax error names its code and
// position and never quotes the document's text.
void test('a document that is not YAML throws NatsServicesInvalid naming the position, not the text', () => {
  const marker = 'ZQXJ-yaml-text-marker';
  assert.throws(
    () => parseNatsServices(`services:\n  - name: ${marker}\n    publish: [unclosed\n`),
    (error: unknown) =>
      error instanceof NatsServicesInvalid &&
      /^not YAML: [A-Z_]+ at line \d+, column \d+$/.test(error.message) &&
      !error.message.includes(marker),
  );
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

void test('eventSubjectsFor: a type declared on a non-events root takes that root, and only subscribers of that root receive it', () => {
  // The live SSoT declares SensorReading on both roots, so a rule that counted only `events.`
  // grants still found a producer there and no live assertion could tell. A type published only
  // on `telemetry.` has no `events.*.<T>` subject: its default-root subscriber is not a receiver.
  const services = [
    service({
      name: 'farm_service',
      publish: ['telemetry.*.BatchHarvested', '$JS.API.INFO', '_INBOX.>'],
    }),
    service({
      name: 'events_root_service',
      subscribe: ['events.*.BatchHarvested', '_INBOXEVENTS.>'],
    }),
    service({
      name: 'telemetry_root_service',
      subscribe: ['telemetry.*.BatchHarvested', '_INBOXTELEMETRY.>'],
    }),
  ];
  assert.deepEqual(eventSubjectsFor('BatchHarvested', services), {
    subjects: ['telemetry.*.BatchHarvested'],
    source: 'declared',
  });
  const ripple = aclEventRipple('BatchHarvested', services);
  assert.deepEqual(ripple.subjects, ['telemetry.*.BatchHarvested']);
  assert.deepEqual(
    ripple.producers.map(({ service: s, grant }) => [s.name, grant]),
    [['farm_service', 'telemetry.*.BatchHarvested']],
  );
  assert.deepEqual(
    ripple.aclSubscribers.map(({ service: s, grant }) => [s.name, grant]),
    [['telemetry_root_service', 'telemetry.*.BatchHarvested']],
  );

  // Declared on two roots: both are its subjects, sorted, and a subscriber on either receives it.
  const both = [
    ...services,
    service({
      name: 'ingest_service',
      publish: ['events.*.BatchHarvested', '$JS.API.INFO', '_INBOX.>'],
    }),
  ];
  assert.deepEqual(eventSubjectsFor('BatchHarvested', both), {
    subjects: ['events.*.BatchHarvested', 'telemetry.*.BatchHarvested'],
    source: 'declared',
  });
  assert.deepEqual(
    aclEventRipple('BatchHarvested', both).aclSubscribers.map(({ service: s }) => s.name),
    ['events_root_service', 'telemetry_root_service'],
  );
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

/**
 * Sources under `dir`, outside node_modules and fixtures. Under tools/ a spec or test is left out:
 * there it builds temp services.yaml fixtures or is the live oracle. Under tests/invariants every
 * file is a spec, and a spec that reads the SSoT is exactly the private reader this pin refuses.
 */
function sourcesUnder(dir: string, includeSpecs: boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'fixtures') continue;
    if (statSync(path).isDirectory()) out.push(...sourcesUnder(path, includeSpecs));
    else if (
      /\.(ts|mts|mjs|js)$/.test(name) &&
      (includeSpecs || !/\.(spec|test)\.[mc]?[jt]s$/.test(name))
    )
      out.push(path);
  }
  return out;
}

/**
 * Where a private reader could live: every tool (ARIA-MEDIUM-314), every invariant spec and every
 * NATS operator script, the messaging ACL smoke and its test included (ARIA-LOW-603). The e2e oracles (e2e/tests/integration/nats-invariants.spec.ts and
 * nats-subject-contract.spec.ts) stay outside on purpose: they judge the broker semantics this
 * module implements and must not depend on it.
 */
const PINNED_SOURCES = (): string[] => [
  ...sourcesUnder(join(REPO_ROOT, 'tools'), false),
  ...sourcesUnder(join(REPO_ROOT, 'tests', 'invariants'), true),
  ...sourcesUnder(join(REPO_ROOT, 'scripts', 'nats'), true),
];

void test('no tool, invariant or NATS script outside this module names the services.yaml path, so none reads it privately', () => {
  // A string literal whose whole content is a path whose last segment is services.yaml, or a
  // path join ending in that segment: the shape of every private reader this module replaced.
  // Prose that mentions the file inside a longer string does not match, and neither does another
  // file whose name merely ends in "services.yaml" (a helm backend-services.yaml).
  const pathLiteral = /(['"`])(?:[\w.-]+\/)*services\.yaml\1|,\s*(['"`])services\.yaml\2\s*\)/;
  const flagged = PINNED_SOURCES()
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
