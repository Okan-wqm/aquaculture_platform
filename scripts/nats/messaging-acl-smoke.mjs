#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { connect } from '@nats-io/transport-node';
import Ajv from 'ajv';
import yaml from 'js-yaml';

const repoRoot = process.cwd();
const GENERATED_BEGIN =
  '# BEGIN GENERATED — DO NOT EDIT BY HAND (scripts/nats/generate-nats-conf.py)';
const GENERATED_END = '# END GENERATED';
const ALLOWED_NOTIFICATION_COMMANDS = new Set([
  'commands.notification.sendEmail',
  'commands.notification.sendPush',
]);
const MARINE_CREDENTIAL_SUBJECTS = new Set([
  'config.marine_credentials.resolve',
  'config.marine_credentials.upsert',
]);
const MARINE_CREDENTIAL_INBOX = '_INBOXFARMMARINECFG.>';
const AUTHORITY_TOKEN =
  /\b(?:authorization|accounts|operator|resolver|auth_callout|no_auth_user|default_permission|users?|username|password|pass|token|nkey)\b/i;
const responsePolicy = parseJson(readFileSync(
  new URL('../../libs/backend-common/src/nats/nats-response-policy.json', import.meta.url), 'utf8'),
'nats-response-policy.json');

function readRepoFile(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${message}`);
  }
}

function parseYaml(source, label) {
  try {
    return yaml.load(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid YAML: ${message}`);
  }
}

function assertUnique(values, label) {
  if (values.length !== new Set(values).size) {
    throw new Error(`${label} contains duplicate values`);
  }
}

function assertNatsSubject(subject, label) {
  const tokens = subject.split('.');
  if (tokens.some((token) => token.length === 0)) {
    throw new Error(`${label} has an empty NATS subject token: ${subject}`);
  }
  for (const [index, token] of tokens.entries()) {
    if ((token.includes('*') && token !== '*') || (token.includes('>') && token !== '>')) {
      throw new Error(`${label} has a partial NATS subject wildcard token: ${subject}`);
    }
    if (token === '>' && index !== tokens.length - 1) {
      throw new Error(`${label} has a NATS subject wildcard before the final token: ${subject}`);
    }
  }
}

export function parseServicesRegistry(servicesYaml, servicesSchemaJson) {
  const document = parseYaml(servicesYaml, 'services.yaml');
  const schema = parseJson(servicesSchemaJson, 'services.schema.json');
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  if (!validate(document)) {
    throw new Error(`services.yaml schema violations: ${JSON.stringify(validate.errors ?? [])}`);
  }

  const registry = new Map();
  const applications = [];
  for (const service of document.services) {
    if (registry.has(service.name)) {
      throw new Error(`services.yaml contains duplicate service ${service.name}`);
    }
    applications.push(service.application);
    assertUnique(service.publish, `services.yaml ${service.name}.publish`);
    assertUnique(service.subscribe, `services.yaml ${service.name}.subscribe`);
    for (const subject of service.publish) {
      assertNatsSubject(subject, `services.yaml ${service.name}.publish`);
    }
    for (const subject of service.subscribe) {
      assertNatsSubject(subject, `services.yaml ${service.name}.subscribe`);
    }
    if (service.responses !== undefined && (
      ![responsePolicy.maxAckResponses, responsePolicy.maxUnaryResponses].includes(service.responses.max) ||
      service.responses.expires !== `${responsePolicy.expirySeconds}s`
    )) throw new Error(`services.yaml ${service.name}.responses differs from shared response policy`);
    registry.set(service.name, {
      application: service.application,
      description: service.description.trim().replace(/\s+/g, ' '),
      publish: new Set(service.publish),
      subscribe: new Set(service.subscribe),
      ...(service.responses === undefined ? {} : {
        responses: { max: service.responses.max, expires: service.responses.expires },
      }),
    });
  }
  assertUnique(applications, 'services.yaml applications');
  assertUnique([...registry.keys()].map((name) => name.toUpperCase().replace(/-/g, '_')),
    'services.yaml inbox prefixes');
  return registry;
}

function renderSubjectList(subjects) {
  return [...subjects].map((subject) => `            ${JSON.stringify(subject)}`).join(',\n');
}

function renderServiceAuthorization(name, service) {
  const responses = service.responses === undefined ? '' :
    `        allow_responses: { max: ${service.responses.max}, expires: ${JSON.stringify(service.responses.expires)} }\n`;
  return `    # ── ${name}: ${service.description} ──
    {
      user: "CN=${name}",
      permissions: {
${responses}        publish: {
          allow: [
${renderSubjectList(service.publish)}
          ]
        }
        subscribe: {
          allow: [
${renderSubjectList(service.subscribe)}
          ]
        }
      }
    }`;
}

export function renderCanonicalNatsAuthorization(registry) {
  const users = [...registry].map(([name, service]) => renderServiceAuthorization(name, service));
  return `authorization {
  timeout: 5
  users: [
    ${GENERATED_BEGIN}
${users.join(',\n')}
    ${GENERATED_END}
  ]
}`;
}

function countOccurrences(source, value) {
  return source.split(value).length - 1;
}

function skipWhitespaceAndComments(source, start) {
  let cursor = start;
  while (cursor < source.length) {
    if (/\s/.test(source[cursor])) {
      cursor += 1;
      continue;
    }
    if (source[cursor] === '#') {
      const newline = source.indexOf('\n', cursor);
      cursor = newline === -1 ? source.length : newline + 1;
      continue;
    }
    break;
  }
  return cursor;
}

function readNatsScalar(source, start, label) {
  let cursor = skipWhitespaceAndComments(source, start);
  const quote = source[cursor];
  if (quote === '"') {
    const tokenStart = cursor;
    cursor += 1;
    let escaped = false;
    while (cursor < source.length) {
      const character = source[cursor];
      if (!escaped && character === '"') {
        const value = parseJson(source.slice(tokenStart, cursor + 1), label);
        if (typeof value !== 'string') throw new Error(`${label} must be a string`);
        return { value, end: cursor + 1 };
      }
      if (character === '\\' && !escaped) {
        escaped = true;
      } else {
        escaped = false;
      }
      cursor += 1;
    }
    throw new Error(`${label} contains an unterminated double-quoted scalar`);
  }
  if (quote === "'") {
    cursor += 1;
    let value = '';
    while (cursor < source.length) {
      const character = source[cursor];
      if (character === "'") return { value, end: cursor + 1 };
      if (character === '\n' || character === '\r') {
        throw new Error(`${label} contains an unterminated single-quoted scalar`);
      }
      value += character;
      cursor += 1;
    }
    throw new Error(`${label} contains an unterminated single-quoted scalar`);
  }

  const tokenStart = cursor;
  while (cursor < source.length && !/[\s,[\]{}#]/.test(source[cursor])) cursor += 1;
  if (cursor === tokenStart) throw new Error(`${label} is missing a scalar value`);
  return { value: source.slice(tokenStart, cursor), end: cursor };
}

function parseNatsSubjectList(source, label) {
  const subjects = [];
  let cursor = 0;
  while (cursor < source.length) {
    cursor = skipWhitespaceAndComments(source, cursor);
    while (source[cursor] === ',') cursor = skipWhitespaceAndComments(source, cursor + 1);
    if (cursor >= source.length) break;
    const scalar = readNatsScalar(source, cursor, label);
    assertNatsSubject(scalar.value, label);
    subjects.push(scalar.value);
    cursor = scalar.end;
  }
  if (subjects.length === 0) throw new Error(`${label} must contain at least one subject`);
  assertUnique(subjects, label);
  return new Set(subjects);
}

function parsePermissionList(userSection, permission, userName) {
  const expression = new RegExp(
    `\\b${permission}\\s*:\\s*\\{\\s*\\ballow\\s*:\\s*\\[([\\s\\S]*?)\\]\\s*\\}`,
  );
  const match = expression.exec(userSection);
  if (!match) throw new Error(`nats.conf user ${userName} is missing ${permission}.allow`);
  return parseNatsSubjectList(match[1], `nats.conf ${userName}.${permission}`);
}

export function parseGeneratedNatsAuthorization(natsConf) {
  const begin = natsConf.indexOf(GENERATED_BEGIN);
  const end = natsConf.indexOf(GENERATED_END, begin + GENERATED_BEGIN.length);
  if (begin === -1 || end === -1 || end <= begin) {
    throw new Error('nats.conf generated authorization sentinels are out of order');
  }

  const generated = natsConf.slice(begin + GENERATED_BEGIN.length, end);
  const userMarkers = [...generated.matchAll(/^ {6}user\s*:/gm)];
  if (userMarkers.length === 0) {
    throw new Error('nats.conf generated authorization contains no users');
  }
  const authorization = new Map();
  for (let index = 0; index < userMarkers.length; index += 1) {
    const marker = userMarkers[index];
    const scalar = readNatsScalar(
      generated,
      marker.index + marker[0].length,
      'nats.conf generated user',
    );
    if (!/^CN=[a-z][a-z0-9_-]*[a-z0-9]$/.test(scalar.value)) {
      throw new Error(`nats.conf generated user has invalid cert identity ${scalar.value}`);
    }
    const serviceName = scalar.value.slice(3);
    if (authorization.has(serviceName)) {
      throw new Error(`nats.conf contains duplicate generated user CN=${serviceName}`);
    }
    const sectionEnd = userMarkers[index + 1]?.index ?? generated.length;
    const section = generated.slice(scalar.end, sectionEnd);
    const responses = /\ballow_responses:\s*\{\s*max:\s*(\d+),\s*expires:\s*"([^"]+)"\s*\}/.exec(section);
    if (/\ballow_responses\b/.test(section) && !responses) {
      throw new Error(`nats.conf ${serviceName}.responses has invalid bounded syntax`);
    }
    authorization.set(serviceName, {
      publish: parsePermissionList(section, 'publish', serviceName),
      subscribe: parsePermissionList(section, 'subscribe', serviceName),
      ...(responses === null ? {} : { responses: { max: Number(responses[1]), expires: responses[2] } }),
    });
  }
  return authorization;
}

function stripNatsComments(source) {
  let result = '';
  let cursor = 0;
  let quote = null;
  while (cursor < source.length) {
    const current = source[cursor];
    const next = source[cursor + 1];
    if (quote !== null) {
      result += current;
      if (current === quote && source[cursor - 1] !== '\\') quote = null;
      cursor += 1;
      continue;
    }
    if (current === '"' || current === "'") {
      quote = current;
      result += current;
      cursor += 1;
      continue;
    }
    if (current === '#' || (current === '/' && next === '/')) {
      const newline = source.indexOf('\n', cursor);
      if (newline === -1) break;
      result += '\n';
      cursor = newline + 1;
      continue;
    }
    if (current === '/' && next === '*') {
      const close = source.indexOf('*/', cursor + 2);
      if (close === -1) throw new Error('unterminated block comment in NATS configuration');
      const comment = source.slice(cursor, close + 2);
      result += comment.replace(/[^\n]/g, ' ');
      cursor = close + 2;
      continue;
    }
    result += current;
    cursor += 1;
  }
  return result;
}

function assertSameSet(actual, expected, label) {
  const missing = [...expected].filter((value) => !actual.has(value));
  const extra = [...actual].filter((value) => !expected.has(value));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${label} differs from services.yaml: missing=[${missing.join(', ')}], extra=[${extra.join(', ')}]`,
    );
  }
}

function assertRequestAndCommandBoundaries(registry) {
  const ownedRequestNamespaces = new Set(
    [...registry.values()].map((service) =>
      service.application.replace(/-(?:service|api|engine)$/, ''),
    ),
  );
  for (const [name, service] of registry) {
    for (const subject of service.publish) {
      if (subject.startsWith('request.')) {
        const tokens = subject.split('.');
        if (tokens.length < 3 || tokens.some((token) => token === '*' || token === '>')) {
          throw new Error(`${name} contains broad request grant ${subject}`);
        }
        if (!ownedRequestNamespaces.has(tokens[1])) {
          throw new Error(
            `${name} contains request grant in unowned request namespace ${tokens[1]}`,
          );
        }
      }
      if (
        subject.startsWith('commands.') &&
        (subject.split('.')[1] === 'notification' ||
          subject.includes('*') ||
          subject.includes('>')) &&
        !ALLOWED_NOTIFICATION_COMMANDS.has(subject)
      ) {
        throw new Error(`${name} exposes unsupported notification command ${subject}`);
      }
    }
  }
}

function assertRequiredMessagingGrants(registry) {
  const messaging = registry.get('messaging_service');
  const gateway = registry.get('gateway_service');
  if (!messaging?.publish.has('events.*.MessageSent')) {
    throw new Error('messaging_service must publish events.*.MessageSent');
  }
  for (const subject of [
    'request.messaging.verifyMembership',
    'request.messaging.resolveNotificationRef',
  ]) {
    if (!gateway?.publish.has(subject)) {
      throw new Error(`gateway_service must publish ${subject}`);
    }
  }
  const allPublish = new Set([...registry.values()].flatMap((service) => [...service.publish]));
  for (const subject of ALLOWED_NOTIFICATION_COMMANDS) {
    if (!allPublish.has(subject)) throw new Error(`NATS ACL is missing ${subject}`);
  }
  for (const forbidden of ['commands.notification.sendSms', 'commands.notification.sendWebhook']) {
    if (allPublish.has(forbidden))
      throw new Error(`NATS ACL exposes unsupported notification command ${forbidden}`);
  }
}

function subjectGrantCovers(grant, subject) {
  const grantTokens = grant.split('.');
  const subjectTokens = subject.split('.');
  for (let index = 0; index < grantTokens.length; index += 1) {
    const token = grantTokens[index];
    if (token === '>') return index < subjectTokens.length;
    if (index >= subjectTokens.length) return false;
    if (token !== '*' && token !== subjectTokens[index]) return false;
  }
  return grantTokens.length === subjectTokens.length;
}

function assertMarineCredentialGrants(registry) {
  const farm = registry.get('farm_service');
  const config = registry.get('config_service');
  if (!farm || !config) {
    throw new Error('marine credential ACL requires farm_service and config_service identities');
  }
  for (const subject of MARINE_CREDENTIAL_SUBJECTS) {
    if (!farm.publish.has(subject)) {
      throw new Error(`farm_service must publish exact marine credential RPC ${subject}`);
    }
    if (!config.subscribe.has(subject)) {
      throw new Error(`config_service must subscribe exact marine credential RPC ${subject}`);
    }
  }
  if (!farm.subscribe.has(MARINE_CREDENTIAL_INBOX)) {
    throw new Error('farm_service must subscribe the scoped marine credential reply inbox');
  }
  if (!config.publish.has(MARINE_CREDENTIAL_INBOX)) {
    throw new Error('config_service must publish the scoped marine credential reply inbox');
  }
  const representativeReply = '_INBOXFARMMARINECFG.reply';
  if (subjectGrantCovers('_INBOX.>', representativeReply)) {
    throw new Error('marine credential reply inbox must remain distinct from generic _INBOX');
  }
  for (const [name, service] of registry) {
    const grants = [...service.publish, ...service.subscribe];
    if (name !== 'farm_service' && name !== 'config_service') {
      const leak = grants.find(
        (grant) =>
          grant.startsWith('config.marine_credentials.') ||
          grant.startsWith('_INBOXFARMMARINECFG.') ||
          subjectGrantCovers(grant, representativeReply),
      );
      if (leak) throw new Error(`${name} leaks the scoped marine credential authority via ${leak}`);
    }
  }
  for (const grant of [...farm.publish, ...config.subscribe]) {
    if (grant.startsWith('config.marine_credentials.') && !MARINE_CREDENTIAL_SUBJECTS.has(grant)) {
      throw new Error(`marine credential ACL must use exact subjects, not ${grant}`);
    }
  }
}

function assertIncludedConfigs(includedConfigs) {
  const development = includedConfigs.get('nats-tls.conf');
  const production = includedConfigs.get('nats-tls-enabled.conf');
  if (typeof development !== 'string' || typeof production !== 'string') {
    throw new Error('static ACL validation requires both canonical TLS include variants');
  }
  for (const [name, source] of includedConfigs) {
    const uncommented = stripNatsComments(source);
    if (AUTHORITY_TOKEN.test(uncommented)) {
      throw new Error(`${name} contains an alternate NATS authority token`);
    }
  }
  if (stripNatsComments(development).trim() !== '') {
    throw new Error('nats-tls.conf is not the canonical no-op development TLS include');
  }
  const normalizedProduction = stripNatsComments(production).replace(/\s+/g, ' ').trim();
  const canonicalProduction = `tls {
    cert_file: "/etc/nats/certs/nats-cert.pem"
    key_file: "/etc/nats/certs/nats-key.pem"
    ca_file: "/etc/nats/certs/ca-cert.pem"
    verify_and_map: true
    timeout: 5
  }`
    .replace(/\s+/g, ' ')
    .trim();
  if (normalizedProduction !== canonicalProduction) {
    throw new Error('nats-tls-enabled.conf is not the canonical cert-only TLS include');
  }
}

export function assertStaticAcl(registry, authorization, natsConf, includedConfigs) {
  if (registry.size !== authorization.size) {
    throw new Error('generated NATS authorization identity count differs from services.yaml');
  }
  for (const [name, service] of registry) {
    const generated = authorization.get(name);
    if (!generated) throw new Error(`generated NATS authorization is missing CN=${name}`);
    assertSameSet(generated.publish, service.publish, `${name}.publish`);
    assertSameSet(generated.subscribe, service.subscribe, `${name}.subscribe`);
    if (JSON.stringify(generated.responses) !== JSON.stringify(service.responses)) {
      throw new Error(`${name}.responses differs from services.yaml`);
    }
  }

  const canonical = renderCanonicalNatsAuthorization(registry);
  const canonicalStart = natsConf.indexOf(canonical);
  if (canonicalStart === -1) {
    throw new Error('nats.conf generated authorization is not the exact canonical output');
  }
  if (
    countOccurrences(natsConf, GENERATED_BEGIN) !== 1 ||
    countOccurrences(natsConf, GENERATED_END) !== 1
  ) {
    throw new Error('nats.conf must contain exactly one generated sentinel pair');
  }

  const outsideAuthorization =
    natsConf.slice(0, canonicalStart) + natsConf.slice(canonicalStart + canonical.length);
  const uncommentedOutside = stripNatsComments(outsideAuthorization);
  if (AUTHORITY_TOKEN.test(uncommentedOutside)) {
    throw new Error('nats.conf top-level envelope drift introduced an alternate authority');
  }
  const includes = [...uncommentedOutside.matchAll(/^\s*include\s+([^\s#]+)\s*$/gm)].map(
    (match) => match[1],
  );
  if (includes.length !== 1 || includes[0] !== 'nats-tls.conf') {
    throw new Error('nats.conf must include only the canonical nats-tls.conf root include');
  }

  assertIncludedConfigs(includedConfigs);
  assertRequestAndCommandBoundaries(registry);
  assertRequiredMessagingGrants(registry);
  assertMarineCredentialGrants(registry);
}

function defaultReadPem(path, label) {
  let pem;
  try {
    pem = readFileSync(path, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} at ${path} could not be read: ${message}`);
  }
  const marker = label === 'NATS_TLS_KEY' ? 'PRIVATE KEY' : 'BEGIN CERTIFICATE';
  if (!pem.includes(marker)) {
    throw new Error(`${label} at ${path} is not valid PEM material (${marker} missing)`);
  }
  return pem;
}

export function buildNatsOptions(env = process.env, readPem = defaultReadPem) {
  const servers = (env.NATS_URL ?? '')
    .split(',')
    .map((server) => server.trim())
    .filter(Boolean);
  if (servers.length === 0) throw new Error('NATS_URL is required for real ACL smoke');
  if (servers.some((server) => !server.startsWith('tls://'))) {
    throw new Error('every NATS_URL endpoint must use tls:// for cert-only ACL smoke');
  }
  if (env.NATS_TLS_ENABLED !== 'true') {
    throw new Error('NATS_TLS_ENABLED must be "true" for cert-only ACL smoke');
  }
  if (env.NATS_TLS_INSECURE_ALLOW === 'true') {
    throw new Error('NATS_TLS_INSECURE_ALLOW is forbidden for cert-only ACL smoke');
  }
  if (env.NATS_AUTH_TOKEN || env.NATS_AUTH_USER || env.NATS_AUTH_PASS) {
    throw new Error('cert-only ACL smoke forbids token, user, and password authentication');
  }
  if (!env.NATS_TLS_CA || !env.NATS_TLS_CERT || !env.NATS_TLS_KEY) {
    throw new Error('cert-only ACL smoke requires NATS_TLS_CA, NATS_TLS_CERT, and NATS_TLS_KEY');
  }
  return {
    servers,
    name: env.NATS_CLIENT_NAME ?? 'messaging-acl-smoke',
    reconnect: false,
    maxReconnectAttempts: 0,
    tls: {
      ca: readPem(env.NATS_TLS_CA, 'NATS_TLS_CA'),
      cert: readPem(env.NATS_TLS_CERT, 'NATS_TLS_CERT'),
      key: readPem(env.NATS_TLS_KEY, 'NATS_TLS_KEY'),
    },
  };
}

function parseMode(argv) {
  const modeIndex = argv.findIndex((arg) => arg === '--mode' || arg.startsWith('--mode='));
  if (modeIndex === -1) return 'live';
  const argument = argv[modeIndex];
  const mode = argument.includes('=')
    ? argument.slice(argument.indexOf('=') + 1)
    : argv[modeIndex + 1];
  if (mode !== 'static' && mode !== 'live') {
    throw new Error(`unsupported --mode ${mode}; expected static or live`);
  }
  return mode;
}

function loadStaticInputs() {
  const services = parseServicesRegistry(
    readRepoFile('infrastructure/nats/services.yaml'),
    readRepoFile('infrastructure/nats/services.schema.json'),
  );
  const natsConf = readRepoFile('infrastructure/docker/nats/nats.conf');
  const authorization = parseGeneratedNatsAuthorization(natsConf);
  const includes = new Map([
    ['nats-tls.conf', readRepoFile('infrastructure/docker/nats/nats-tls.conf')],
    ['nats-tls-enabled.conf', readRepoFile('infrastructure/docker/nats/nats-tls-enabled.conf')],
  ]);
  return { services, authorization, natsConf, includes };
}

async function main() {
  const staticInputs = loadStaticInputs();
  assertStaticAcl(
    staticInputs.services,
    staticInputs.authorization,
    staticInputs.natsConf,
    staticInputs.includes,
  );
  if (parseMode(process.argv) === 'static') {
    process.stdout.write('OK: messaging NATS ACL static checks completed\n');
    return;
  }

  const connection = await connect(buildNatsOptions());
  try {
    const tenantId = process.env.NATS_ACL_SMOKE_TENANT_ID ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    connection.publish(
      `events.${tenantId}.MessageSent`,
      JSON.stringify({
        eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        eventType: 'MessageSent',
        timestamp: new Date().toISOString(),
        tenantId,
        version: 1,
        channelId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        messageId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        senderId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        contentType: 'TEXT',
        hasAttachments: false,
        createdAt: new Date().toISOString(),
      }),
    );
    await connection.flush();
  } finally {
    await connection.drain();
  }
  process.stdout.write('OK: messaging NATS ACL smoke publish completed\n');
}

const isEntrypoint =
  typeof process.argv[1] === 'string' &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isEntrypoint) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`messaging-nats-acl smoke failed: ${message}\n`);
    process.exitCode = 1;
  });
}
