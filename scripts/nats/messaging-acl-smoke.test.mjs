import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  assertStaticAcl,
  buildNatsOptions,
  parseGeneratedNatsAuthorization,
  parseServicesRegistry,
  renderCanonicalNatsAuthorization,
} from './messaging-acl-smoke.mjs';

const servicesSchema = readFileSync(
  new URL('../../infrastructure/nats/services.schema.json', import.meta.url),
  'utf8',
);

const canonicalTlsEnabled = `tls {
  cert_file: "/etc/nats/certs/nats-cert.pem"
  key_file: "/etc/nats/certs/nats-key.pem"
  ca_file: "/etc/nats/certs/ca-cert.pem"
  verify_and_map: true
  timeout: 5
}
`;

function includedConfigs(overrides = {}) {
  return new Map([
    ['nats-tls.conf', overrides.disabled ?? '# TLS disabled in development\n'],
    ['nats-tls-enabled.conf', overrides.enabled ?? canonicalTlsEnabled],
  ]);
}

function scalar(value, style) {
  if (style === 'double') {
    return JSON.stringify(value);
  }
  if (style === 'single') {
    return `'${value}'`;
  }
  return value;
}

function list(values, style, indent) {
  return values.map((value) => `${indent}- ${scalar(value, style)}`).join('\n');
}

function servicesYaml(style) {
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

function natsConf(services) {
  return `# Test fixture
jetstream {
  store_dir: /data
  max_memory_store: 96MB
  max_file_store: 2GB
}

http_port: 8222
logtime: true

${renderCanonicalNatsAuthorization(services)}

include nats-tls.conf
`;
}

function fixture(style = 'double') {
  const services = parseServicesRegistry(servicesYaml(style), servicesSchema);
  const config = natsConf(services);
  return {
    services,
    config,
    authorization: parseGeneratedNatsAuthorization(config),
    includes: includedConfigs(),
  };
}

function assertConfigRejected(config, services, pattern, includes = includedConfigs()) {
  const authorization = parseGeneratedNatsAuthorization(config);
  assert.throws(() => assertStaticAcl(services, authorization, config, includes), pattern);
}

for (const style of ['double', 'single', 'unquoted']) {
  test(`normalizes ${style} services.yaml scalar syntax into canonical NATS config`, () => {
    const { services, authorization, config, includes } = fixture(style);
    assert.doesNotThrow(() => assertStaticAcl(services, authorization, config, includes));
  });
}

test('fails closed when the YAML registry has an unexpected ACL shape', () => {
  const malformed = servicesYaml('single').replace(
    `    publish:\n${list(
      ['events.*.MessageSent', 'commands.notification.sendPush', '$JS.API.>', '_INBOX.>'],
      'single',
      '      ',
    )}`,
    "    publish: 'events.*.MessageSent'",
  );

  assert.throws(
    () => parseServicesRegistry(malformed, servicesSchema),
    /services\.yaml schema violations/,
  );
});

for (const malformedSubject of ['events.foo..bar', 'events.foo*bar', 'request.>.x']) {
  test(`rejects malformed NATS subject grammar: ${malformedSubject}`, () => {
    const malformed = servicesYaml('single').replace(
      "      - 'events.*.MessageSent'",
      `      - 'events.*.MessageSent'\n      - '${malformedSubject}'`,
    );
    assert.throws(
      () => parseServicesRegistry(malformed, servicesSchema),
      /NATS subject (token|wildcard)/,
    );
  });
}

test('fails closed when generated NATS permissions are incomplete', () => {
  const { config } = fixture();
  const malformed = config.replace('        subscribe: {', '        subscriptions: {');
  assert.throws(() => parseGeneratedNatsAuthorization(malformed), /is missing subscribe\.allow/);
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
  test(`rejects non-generated identity inside canonical sentinels: ${manualEntry}`, () => {
    const { services, config } = fixture();
    const mutated = config.replace(
      '    # END GENERATED',
      `    ,\n    ${manualEntry}\n    # END GENERATED`,
    );
    assertConfigRejected(mutated, services, /exact canonical output/);
  });
}

for (const generatedMutation of [
  '      password: "secret",\n      permissions:',
  '      nkey: "UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",\n      permissions:',
  '      token: "secret",\n      permissions:',
]) {
  test(`rejects alternate credential inside generated user: ${generatedMutation.split(':')[0]}`, () => {
    const { services, config } = fixture();
    const mutated = config.replace('      permissions:', generatedMutation);
    assertConfigRejected(mutated, services, /exact canonical output/);
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
  test(`rejects alternate authority outside canonical block: ${outsideAuthority}`, () => {
    const { services, config } = fixture();
    assertConfigRejected(`${config}\n${outsideAuthority}\n`, services, /top-level envelope drift/);
  });
}

test('rejects relocated or spoofed generated sentinels', () => {
  const { services, config } = fixture();
  const relocated = config
    .replace('    # END GENERATED', '')
    .replace('include nats-tls.conf', 'include nats-tls.conf\n# END GENERATED');
  assertConfigRejected(relocated, services, /exact canonical output/);

  const spoofed = config.replace(
    '# BEGIN GENERATED — DO NOT EDIT BY HAND (scripts/nats/generate-nats-conf.py)',
    '// # BEGIN GENERATED — DO NOT EDIT BY HAND (scripts/nats/generate-nats-conf.py)',
  );
  assertConfigRejected(spoofed, services, /exact canonical output/);
});

test('rejects duplicate generated sentinels even when the canonical block remains intact', () => {
  const { services, config } = fixture();
  const duplicated = `# BEGIN GENERATED — DO NOT EDIT BY HAND (scripts/nats/generate-nats-conf.py)\n${config}`;
  assertConfigRejected(duplicated, services, /exactly one .* sentinel/);
});

test('ignores authorization-like text in supported comment forms', () => {
  const { services, config, authorization, includes } = fixture();
  const withComments = config.replace(
    'include nats-tls.conf',
    `// user: "CN=comment_only" permissions: { allow: ["request.>"] }
/*
authorization { users: [{ username: "comment_only" }] }
*/
include nats-tls.conf`,
  );
  assert.doesNotThrow(() => assertStaticAcl(services, authorization, withComments, includes));
});

test('rejects malformed block comments instead of scanning through them', () => {
  const { services, config } = fixture();
  assertConfigRejected(`${config}\n/* unterminated`, services, /unterminated block comment/);
});

for (const includeSyntax of [
  'include manual-auth.conf',
  'include = nats-tls.conf',
  'include $NATS_AUTH_CONFIG',
]) {
  test(`rejects non-canonical root include: ${includeSyntax}`, () => {
    const { services, config } = fixture();
    const mutated = config.replace('include nats-tls.conf', includeSyntax);
    assertConfigRejected(mutated, services, /(top-level envelope drift|must include only)/);
  });
}

test('recursively rejects authority in the included development TLS config', () => {
  const { services, config, authorization } = fixture();
  const includes = includedConfigs({
    disabled: 'authorization { users: [{ username: "rogue" }] }\n',
  });
  assert.throws(
    () => assertStaticAcl(services, authorization, config, includes),
    /alternate NATS authority token/,
  );
});

test('rejects non-cert-only production TLS include drift', () => {
  const { services, config, authorization } = fixture();
  const includes = includedConfigs({
    enabled: canonicalTlsEnabled.replace('verify_and_map: true', 'verify_and_map: false'),
  });
  assert.throws(
    () => assertStaticAcl(services, authorization, config, includes),
    /not the canonical cert-only TLS include/,
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
  test(`rejects broad request grant by token semantics: ${broadGrant}`, () => {
    const { services, includes } = fixture();
    services.get('gateway_service').publish.add(broadGrant);
    const config = natsConf(services);
    const authorization = parseGeneratedNatsAuthorization(config);
    assert.throws(
      () => assertStaticAcl(services, authorization, config, includes),
      /broad request grant/,
    );
  });
}

test('rejects an exact request grant in an unowned namespace', () => {
  const { services, includes } = fixture();
  services.get('gateway_service').publish.add('request.rogue.operation');
  const config = natsConf(services);
  const authorization = parseGeneratedNatsAuthorization(config);
  assert.throws(
    () => assertStaticAcl(services, authorization, config, includes),
    /unowned request namespace rogue/,
  );
});

test('rejects a marine credential RPC wildcard in place of the exact subjects', () => {
  const { services, includes } = fixture();
  services.get('farm_service').publish.add('config.marine_credentials.>');
  const config = natsConf(services);
  const authorization = parseGeneratedNatsAuthorization(config);
  assert.throws(
    () => assertStaticAcl(services, authorization, config, includes),
    /marine credential ACL must use exact subjects/,
  );
});

test('rejects a scoped marine credential reply-inbox grant on another identity', () => {
  const { services, includes } = fixture();
  services.get('gateway_service').subscribe.add('_INBOXFARMMARINECFG.>');
  const config = natsConf(services);
  const authorization = parseGeneratedNatsAuthorization(config);
  assert.throws(
    () => assertStaticAcl(services, authorization, config, includes),
    /leaks the scoped marine credential authority/,
  );
});

for (const unsupportedGrant of [
  'commands.>',
  'commands.notification.>',
  'commands.notification.*',
]) {
  test(`rejects wildcard exposure of unsupported commands: ${unsupportedGrant}`, () => {
    const { services, includes } = fixture();
    services.get('gateway_service').publish.add(unsupportedGrant);
    const config = natsConf(services);
    const authorization = parseGeneratedNatsAuthorization(config);
    assert.throws(
      () => assertStaticAcl(services, authorization, config, includes),
      /exposes unsupported notification command/,
    );
  });
}

test('builds live smoke options only from a complete cert identity', () => {
  const env = {
    NATS_URL: 'tls://nats.example.test:4222',
    NATS_TLS_ENABLED: 'true',
    NATS_TLS_CA: '/certs/ca.pem',
    NATS_TLS_CERT: '/certs/client.pem',
    NATS_TLS_KEY: '/certs/client-key.pem',
  };
  const options = buildNatsOptions(env, (_path, label) => `${label}-pem`);
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
]) {
  test(`rejects ${label} for live cert-only ACL smoke`, () => {
    const env = {
      NATS_URL: 'tls://nats.example.test:4222',
      NATS_TLS_ENABLED: 'true',
      NATS_TLS_CA: '/certs/ca.pem',
      NATS_TLS_CERT: '/certs/client.pem',
      NATS_TLS_KEY: '/certs/client-key.pem',
      ...override,
    };
    assert.throws(() => buildNatsOptions(env, () => 'pem'), pattern);
  });
}
