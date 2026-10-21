#!/usr/bin/env ts-node
/**
 * Adversarial tests of the messaging NATS ACL smoke (scripts/nats/messaging-acl-smoke.ts):
 * the generated cert-only authorization surface, its envelope, and the live connection options.
 *
 * services.yaml text is parsed by the shared reader (tools/gates/nats-services.ts,
 * ARIA-LOW-603), so a fixture registry is exactly what the smoke sees in production.
 *
 * Invoke via:
 *   ts-node --project tools/gates/tsconfig.json scripts/nats/messaging-acl-smoke.test.ts
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { NatsServicesInvalid, parseNatsServices } from '../../tools/gates/nats-services';

import {
  assertStaticAcl,
  buildNatsOptions,
  type GeneratedAuthorization,
  loadStaticInputs,
  parseGeneratedNatsAuthorization,
  servicesRegistry,
  type ServicesRegistry,
} from './messaging-acl-smoke';

const canonicalTlsEnabled = `tls {
  cert_file: "/etc/nats/certs/nats-cert.pem"
  key_file: "/etc/nats/certs/nats-key.pem"
  ca_file: "/etc/nats/certs/ca-cert.pem"
  verify_and_map: true
  timeout: 5
}
`;

function includedConfigs(
  overrides: { readonly disabled?: string; readonly enabled?: string } = {},
): ReadonlyMap<string, string> {
  return new Map([
    ['nats-tls.conf', overrides.disabled ?? '# TLS disabled in development\n'],
    ['nats-tls-enabled.conf', overrides.enabled ?? canonicalTlsEnabled],
  ]);
}

type ScalarStyle = 'double' | 'single' | 'unquoted';

function scalar(value: string, style: ScalarStyle): string {
  if (style === 'double') {
    return JSON.stringify(value);
  }
  if (style === 'single') {
    return `'${value}'`;
  }
  return value;
}

function list(values: readonly string[], style: ScalarStyle, indent: string): string {
  return values.map((value) => `${indent}- ${scalar(value, style)}`).join('\n');
}

function servicesYaml(style: ScalarStyle): string {
  return `version: 1
services:
  - name: messaging_service
    application: messaging-service
    description: Messaging service test identity
    publish:
${list(
  ['events.*.MessageSent', 'commands.notification.sendPush', '$JS.API.>', '_INBOX.>'],
  style,
  '      ',
)}
    subscribe:
${list(['$JS.API.>', '_INBOX.>'], style, '      ')}
  - name: gateway_service
    application: gateway-api
    description: Gateway service test identity
    publish:
${list(
  [
    'request.messaging.verifyMembership',
    'request.messaging.resolveNotificationRef',
    'commands.notification.sendEmail',
    '$JS.API.>',
    '_INBOX.>',
  ],
  style,
  '      ',
)}
    subscribe:
${list(['$JS.API.>', '_INBOX.>'], style, '      ')}
  - name: farm_service
    application: farm-service
    description: Farm service marine credential test identity
    publish:
${list(
  [
    'config.marine_credentials.resolve',
    'config.marine_credentials.upsert',
    '$JS.API.>',
    '_INBOX.>',
  ],
  style,
  '      ',
)}
    subscribe:
${list(['_INBOXFARMMARINECFG.>', '$JS.API.>', '_INBOX.>'], style, '      ')}
  - name: config_service
    application: config-service
    description: Configuration service marine credential test identity
    publish:
${list(['_INBOXFARMMARINECFG.>', '$JS.API.>', '_INBOX.>'], style, '      ')}
    subscribe:
${list(
  [
    'config.marine_credentials.resolve',
    'config.marine_credentials.upsert',
    '$JS.API.>',
    '_INBOX.>',
  ],
  style,
  '      ',
)}
`;
}

/**
 * The generated block for a fixture registry, in the owner's CURRENT form — `allow_responses`
 * included (scripts/nats/generate-nats-conf.py renders it since e25c768f8). A test-INPUT
 * builder, not a production rule: the canonical form is derived from the Python generator at
 * run time — the real-tree tests below pin that — and this only shapes synthetic config for the
 * parser/envelope/boundary refusals.
 */
function fixtureBlock(services: ServicesRegistry): string {
  const users = [...services].map(([name, service]) => {
    const publish = [...service.publish]
      .map((subject) => `            ${JSON.stringify(subject)}`)
      .join(',\n');
    const subscribe = [...service.subscribe]
      .map((subject) => `            ${JSON.stringify(subject)}`)
      .join(',\n');
    return `    # ── ${name} ──
    {
      user: "CN=${name}",
      permissions: {
        publish: {
          allow: [
${publish}
          ]
        }
        subscribe: {
          allow: [
${subscribe}
          ]
        }
        allow_responses: { max: 64, expires: "5m" }
      }
    }`;
  });
  return `    # BEGIN GENERATED — DO NOT EDIT BY HAND (scripts/nats/generate-nats-conf.py)
${users.join(',\n')}
    # END GENERATED`;
}

function natsConfFrom(block: string): string {
  return `# Test fixture
jetstream {
  store_dir: /data
  max_memory_store: 96MB
  max_file_store: 2GB
}

http_port: 8222
logtime: true

authorization {
  timeout: 5
  users: [
${block}
  ]
}

include nats-tls.conf
`;
}

interface Fixture {
  readonly services: ServicesRegistry;
  readonly block: string;
  readonly config: string;
  readonly authorization: GeneratedAuthorization;
  readonly includes: ReadonlyMap<string, string>;
}

function fixture(style: ScalarStyle = 'double'): Fixture {
  const services = servicesRegistry(parseNatsServices(servicesYaml(style)));
  const block = fixtureBlock(services);
  const config = natsConfFrom(block);
  return {
    services,
    block,
    config,
    authorization: parseGeneratedNatsAuthorization(config),
    includes: includedConfigs(),
  };
}

/** `services` with one more grant on one identity: the registry under test is never mutated. */
function withGrant(
  services: ServicesRegistry,
  name: string,
  permission: 'publish' | 'subscribe',
  grant: string,
): ServicesRegistry {
  return new Map(
    [...services].map(([serviceName, service]) => [
      serviceName,
      serviceName === name
        ? { ...service, [permission]: new Set([...service[permission], grant]) }
        : service,
    ]),
  );
}

/** The generated config for `services` plus one grant, and the static check of it. */
function assertGrantRejected(
  name: string,
  permission: 'publish' | 'subscribe',
  grant: string,
  pattern: RegExp,
): void {
  const { services, includes } = fixture();
  const granted = withGrant(services, name, permission, grant);
  const block = fixtureBlock(granted);
  const config = natsConfFrom(block);
  const authorization = parseGeneratedNatsAuthorization(config);
  assert.throws(() => assertStaticAcl(granted, authorization, config, includes, block), pattern);
}

function assertConfigRejected(
  config: string,
  services: ServicesRegistry,
  pattern: RegExp,
  includes: ReadonlyMap<string, string> = includedConfigs(),
  block: string = fixtureBlock(services),
): void {
  // The parse sits inside the assertion: a config whose sentinels no longer bracket the
  // users is refused by the marker scan itself, before any comparison runs.
  assert.throws(() => {
    const authorization = parseGeneratedNatsAuthorization(config);
    assertStaticAcl(services, authorization, config, includes, block);
  }, pattern);
}

for (const style of ['double', 'single', 'unquoted'] as const) {
  void test(`normalizes ${style} services.yaml scalar syntax into canonical NATS config`, () => {
    const { services, authorization, config, includes, block } = fixture(style);
    assert.doesNotThrow(() => assertStaticAcl(services, authorization, config, includes, block));
  });
}

void test('fails closed when the YAML registry has an unexpected ACL shape', () => {
  const malformed = servicesYaml('single').replace(
    `    publish:\n${list(
      ['events.*.MessageSent', 'commands.notification.sendPush', '$JS.API.>', '_INBOX.>'],
      'single',
      '      ',
    )}`,
    "    publish: 'events.*.MessageSent'",
  );

  assert.throws(
    () => servicesRegistry(parseNatsServices(malformed)),
    (error: unknown) =>
      error instanceof NatsServicesInvalid &&
      /does not match .*services\.schema\.json/.test(error.message),
  );
});

for (const malformedSubject of ['events.foo..bar', 'events.foo*bar', 'request.>.x']) {
  void test(`rejects malformed NATS subject grammar: ${malformedSubject}`, () => {
    const malformed = servicesYaml('single').replace(
      "      - 'events.*.MessageSent'",
      `      - 'events.*.MessageSent'\n      - '${malformedSubject}'`,
    );
    assert.throws(
      () => servicesRegistry(parseNatsServices(malformed)),
      (error: unknown) =>
        error instanceof NatsServicesInvalid && /NATS subject (token|wildcard)/.test(error.message),
    );
  });
}

void test('fails closed when generated NATS permissions are incomplete', () => {
  const { config } = fixture();
  const malformed = config.replace('        subscribe: {', '        subscriptions: {');
  assert.throws(() => parseGeneratedNatsAuthorization(malformed), /is missing subscribe\.allow/);
});

void test('rejects malformed NATS subject grammar inside the generated authorization', () => {
  const { config } = fixture();
  const malformed = config.replace('"events.*.MessageSent"', '"events.foo*bar"');
  assert.throws(() => parseGeneratedNatsAuthorization(malformed), /NATS subject wildcard/);
});

for (const manualEntry of [
  '{ user: "CN=manual_operator" }',
  '{ USER: "CN=manual_operator" }',
  '{ user = "CN=manual_operator" }',
  '{ user "CN=manual_operator" }',
  '{ "user": "CN=json_rogue" }',
  '{ username: "manual.example" }',
  '{ username: "manual@example.test", pass: "secret" }',
  '{ user: "CN=manual_operator", permissions: { publish: ["request.>"] } }',
]) {
  void test(`rejects non-generated identity inside canonical sentinels: ${manualEntry}`, () => {
    const { services, config } = fixture();
    const mutated = config.replace(
      '    # END GENERATED',
      `    ,\n    ${manualEntry}\n    # END GENERATED`,
    );
    assertConfigRejected(mutated, services, /generate-nats-conf\.py/);
  });
}

for (const generatedMutation of [
  '      password: "secret",\n      permissions:',
  '      nkey: "UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",\n      permissions:',
  '      token: "secret",\n      permissions:',
]) {
  void test(`rejects alternate credential inside generated user: ${generatedMutation.split(':')[0]}`, () => {
    const { services, config } = fixture();
    const mutated = config.replace('      permissions:', generatedMutation);
    assertConfigRejected(mutated, services, /generate-nats-conf\.py/);
  });
}

for (const outsideAuthority of [
  'no_auth_user: $NATS_NO_AUTH_USER',
  'authorization { username: $MANUAL_CN }',
  'accounts { ROGUE: { users: [{ username: "rogue" }] } }',
  'operator: $NATS_OPERATOR',
  'resolver: MEMORY',
  'auth_callout { issuer: "rogue" }',
  'default_permission: { publish: ["request.>"] }',
]) {
  void test(`rejects alternate authority outside canonical block: ${outsideAuthority}`, () => {
    const { services, config } = fixture();
    assertConfigRejected(`${config}\n${outsideAuthority}\n`, services, /top-level envelope drift/);
  });
}

void test('rejects relocated or spoofed generated sentinels', () => {
  const { services, config } = fixture();
  // The END marker moved outside the authorization block, unindented: the marker scan
  // refuses it (the sentinels no longer bracket the users), not the canonical compare.
  const relocated = config
    .replace('    # END GENERATED', '')
    .replace('include nats-tls.conf', 'include nats-tls.conf\n# END GENERATED');
  assertConfigRejected(relocated, services, /sentinels are out of order/);

  // A commented-out BEGIN is not a marker: the block is never located.
  const spoofed = config.replace(
    '# BEGIN GENERATED — DO NOT EDIT BY HAND (scripts/nats/generate-nats-conf.py)',
    '// # BEGIN GENERATED — DO NOT EDIT BY HAND (scripts/nats/generate-nats-conf.py)',
  );
  assertConfigRejected(spoofed, services, /sentinels are out of order/);
});

void test('rejects duplicate generated sentinels even when the canonical block remains intact', () => {
  const { services, config } = fixture();
  // Indented like the real line: a copy-pasted duplicate, not a prose mention.
  const duplicated = `    # BEGIN GENERATED — DO NOT EDIT BY HAND (scripts/nats/generate-nats-conf.py)\n${config}`;
  assertConfigRejected(duplicated, services, /exactly one .* sentinel/);
});

void test('ignores authorization-like text in supported comment forms', () => {
  const { services, config, authorization, includes, block } = fixture();
  const withComments = config.replace(
    'include nats-tls.conf',
    `// user: "CN=comment_only" permissions: { allow: ["request.>"] }
/*
authorization { users: [{ username: "comment_only" }] }
*/
include nats-tls.conf`,
  );
  assert.doesNotThrow(() =>
    assertStaticAcl(services, authorization, withComments, includes, block),
  );
});

void test('rejects malformed block comments instead of scanning through them', () => {
  const { services, config } = fixture();
  assertConfigRejected(`${config}\n/* unterminated`, services, /unterminated block comment/);
});

for (const includeSyntax of [
  'include manual-auth.conf',
  'include = nats-tls.conf',
  'include $NATS_AUTH_CONFIG',
]) {
  void test(`rejects non-canonical root include: ${includeSyntax}`, () => {
    const { services, config } = fixture();
    const mutated = config.replace('include nats-tls.conf', includeSyntax);
    assertConfigRejected(mutated, services, /(top-level envelope drift|must include only)/);
  });
}

void test('recursively rejects authority in the included development TLS config', () => {
  const { services, config, authorization, block } = fixture();
  const includes = includedConfigs({
    disabled: 'authorization { users: [{ username: "rogue" }] }\n',
  });
  assert.throws(
    () => assertStaticAcl(services, authorization, config, includes, block),
    /alternate NATS authority token/,
  );
});

void test('rejects non-cert-only production TLS include drift', () => {
  const { services, config, authorization, block } = fixture();
  const includes = includedConfigs({
    enabled: canonicalTlsEnabled.replace('verify_and_map: true', 'verify_and_map: false'),
  });
  assert.throws(
    () => assertStaticAcl(services, authorization, config, includes, block),
    /not the canonical cert-only TLS include/,
  );
});

// ── The canonical-form rule: derived from the Python owner, never re-rendered here ──
//
// scripts/nats/generate-nats-conf.py owns the rendered form of the generated
// block. Its `allow_responses` line (INFRA-HIGH-188, e25c768f8, 2026-09-20) is
// the exact drift this section pins: a private TS renderer that omits it is
// permanently red against the committed tree, and one that re-implements the
// owner today drifts again the day the owner changes.

void test('the wired static command passes on the committed tree (real entry, real files)', () => {
  const repoRoot = resolve(__dirname, '..', '..');
  const run = spawnSync(
    process.execPath,
    [
      join(repoRoot, 'node_modules', '.bin', 'ts-node'),
      '--project',
      'tools/gates/tsconfig.json',
      'scripts/nats/messaging-acl-smoke.ts',
      '--mode',
      'static',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(
    run.status,
    0,
    `the static smoke must pass on the committed tree\nstdout: ${run.stdout}\nstderr: ${run.stderr}`,
  );
  assert.match(run.stdout, /OK: messaging NATS ACL static checks completed/);
});

void test('a block that drops allow_responses (the e25c768f8 drift shape) is refused', () => {
  const inputs = loadStaticInputs();
  const drifted = inputs.natsConf.replace(
    /^ {8}allow_responses: \{ max: 64, expires: "5m" \}\n/gm,
    '',
  );
  if (drifted === inputs.natsConf) {
    throw new Error('drift fixture did not remove any allow_responses line');
  }
  assert.throws(
    () =>
      assertStaticAcl(
        inputs.services,
        parseGeneratedNatsAuthorization(drifted),
        drifted,
        inputs.includes,
        inputs.ownerBlock,
      ),
    /generate-nats-conf\.py/,
  );
});

for (const broadGrant of [
  'request.>',
  'request.*',
  'request.*.>',
  'request.*.foo',
  'request.*.*.*',
  'request.*.*.>',
  'request.messaging.*',
  'request.messaging.*.*',
  'request.messaging.admin.*',
  'request.messaging.admin.>',
  'request.*.verifyMembership',
]) {
  void test(`rejects broad request grant by token semantics: ${broadGrant}`, () => {
    assertGrantRejected('gateway_service', 'publish', broadGrant, /broad request grant/);
  });
}

void test('rejects an exact request grant in an unowned namespace', () => {
  assertGrantRejected(
    'gateway_service',
    'publish',
    'request.rogue.operation',
    /unowned request namespace rogue/,
  );
});

void test('rejects a marine credential RPC wildcard in place of the exact subjects', () => {
  assertGrantRejected(
    'farm_service',
    'publish',
    'config.marine_credentials.>',
    /marine credential ACL must use exact subjects/,
  );
});

void test('rejects a scoped marine credential reply-inbox grant on another identity', () => {
  assertGrantRejected(
    'gateway_service',
    'subscribe',
    '_INBOXFARMMARINECFG.>',
    /leaks the scoped marine credential authority/,
  );
});

for (const unsupportedGrant of [
  'commands.>',
  'commands.notification.>',
  'commands.notification.*',
]) {
  void test(`rejects wildcard exposure of unsupported commands: ${unsupportedGrant}`, () => {
    assertGrantRejected(
      'gateway_service',
      'publish',
      unsupportedGrant,
      /exposes unsupported notification command/,
    );
  });
}

const CERT_ONLY_ENV: NodeJS.ProcessEnv = {
  NATS_URL: 'tls://nats.example.test:4222',
  NATS_TLS_ENABLED: 'true',
  NATS_TLS_CA: '/certs/ca.pem',
  NATS_TLS_CERT: '/certs/client.pem',
  NATS_TLS_KEY: '/certs/client-key.pem',
};

void test('builds live smoke options only from a complete cert identity', () => {
  const options = buildNatsOptions(CERT_ONLY_ENV, (_path, label) => `${label}-pem`);
  assert.deepEqual(options.tls, {
    ca: 'NATS_TLS_CA-pem',
    cert: 'NATS_TLS_CERT-pem',
    key: 'NATS_TLS_KEY-pem',
  });
  assert.equal('token' in options, false);
  assert.equal('user' in options, false);
  assert.equal('pass' in options, false);
});

for (const [label, override, pattern] of [
  ['plaintext URL', { NATS_URL: 'nats://nats:4222' }, /every NATS_URL endpoint/],
  ['mixed URLs', { NATS_URL: 'tls://nats:4222,nats://fallback:4222' }, /every NATS_URL/],
  ['disabled TLS flag', { NATS_TLS_ENABLED: 'false' }, /NATS_TLS_ENABLED/],
  ['insecure TLS', { NATS_TLS_INSECURE_ALLOW: 'true' }, /NATS_TLS_INSECURE_ALLOW/],
  ['missing client key', { NATS_TLS_KEY: undefined }, /requires NATS_TLS_CA/],
  ['token auth', { NATS_AUTH_TOKEN: 'secret' }, /forbids token/],
  ['user auth', { NATS_AUTH_USER: 'legacy', NATS_AUTH_PASS: 'secret' }, /forbids token/],
] as const) {
  void test(`rejects ${label} for live cert-only ACL smoke`, () => {
    const env: NodeJS.ProcessEnv = { ...CERT_ONLY_ENV, ...override };
    assert.throws(() => buildNatsOptions(env, () => 'pem'), pattern);
  });
}
