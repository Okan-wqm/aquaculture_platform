#!/usr/bin/env ts-node
/**
 * Messaging NATS ACL smoke — static checks of the generated cert-only authorization, and a live
 * publish through it.
 *
 *   --mode static   services.yaml ↔ generated nats.conf ↔ TLS includes, plus the messaging,
 *                   notification-command and marine-credential boundaries (no broker).
 *   --mode live     the static checks, then one MessageSent publish over a cert-only TLS
 *                   connection (NATS_URL, NATS_TLS_CA/CERT/KEY); run by
 *                   scripts/nats/messaging-acl-smoke-harness.sh against a throwaway broker.
 *
 * services.yaml is read, and NATS subjects matched, only through tools/gates/nats-services.ts
 * (ARIA-LOW-603). This file used to be an .mjs with its own YAML parse and schema validation, its
 * own subject-grammar check and its own matcher, which an .mjs could not share with the TypeScript
 * reader; it runs through ts-node, as the boot-path smoke beside it does.
 *
 * The canonical FORM of the generated block is not rendered here at all: it is derived from the
 * one owner, scripts/nats/generate-nats-conf.py --print-generated-block. A previous private
 * renderer in this smoke drifted from the generator when it started emitting allow_responses
 * (INFRA-HIGH-188, e25c768f8), which left the static smoke permanently red against the committed
 * tree — and blind to a block that drops every allow_responses line, because the private renderer
 * omitted them too. Deriving the bytes from the owner makes that impossible.
 *
 * Every input is read from THIS checkout (module-relative), like the reader's default, so the
 * services.yaml and the nats.conf it is compared with come from the same tree whatever the cwd.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { connect, type NodeConnectionOptions } from '@nats-io/transport-node';

import {
  loadNatsServices,
  natsSubjectGrammarError,
  type NatsServiceEntry,
  subjectMatches,
} from '../../tools/gates/nats-services';

const REPO_ROOT = resolve(__dirname, '..', '..');
const GENERATOR = 'scripts/nats/generate-nats-conf.py';
/** The Python owner's sentinel constants, byte for byte (their 4-space indent included). */
const GENERATED_BEGIN =
  '    # BEGIN GENERATED — DO NOT EDIT BY HAND (scripts/nats/generate-nats-conf.py)';
const GENERATED_END = '    # END GENERATED';
/**
 * The hand-maintained envelope around the generated block. No other owner exists for this form
 * (the generator splices only between the sentinels), so this smoke owns the pin — unlike the
 * block itself, which the generator renders.
 */
const AUTHORIZATION_ENVELOPE_PREFIX = 'authorization {\n  timeout: 5\n  users: [\n';
const AUTHORIZATION_ENVELOPE_SUFFIX = '\n  ]\n}';
const ALLOWED_NOTIFICATION_COMMANDS: ReadonlySet<string> = new Set([
  'commands.notification.sendEmail',
  'commands.notification.sendPush',
]);
const MARINE_CREDENTIAL_SUBJECTS: ReadonlySet<string> = new Set([
  'config.marine_credentials.resolve',
  'config.marine_credentials.upsert',
]);
const MARINE_CREDENTIAL_INBOX = '_INBOXFARMMARINECFG.>';
const AUTHORITY_TOKEN =
  /\b(?:authorization|accounts|operator|resolver|auth_callout|no_auth_user|default_permission|users?|username|password|pass|token|nkey)\b/i;

/** One identity of services.yaml, as the generated nats.conf renders it. */
export interface RegistryService {
  readonly application: string;
  readonly publish: ReadonlySet<string>;
  readonly subscribe: ReadonlySet<string>;
}
export type ServicesRegistry = ReadonlyMap<string, RegistryService>;

/** One generated `user:` block of nats.conf. */
export interface GeneratedPermissions {
  readonly publish: ReadonlySet<string>;
  readonly subscribe: ReadonlySet<string>;
}
export type GeneratedAuthorization = ReadonlyMap<string, GeneratedPermissions>;

function readRepoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJson(source: string, label: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${errorMessage(error)}`);
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (values.length !== new Set(values).size) {
    throw new Error(`${label} contains duplicate values`);
  }
}

function assertNatsSubject(subject: string, label: string): void {
  const grammar = natsSubjectGrammarError(subject);
  if (grammar !== null) throw new Error(`${label} ${grammar}`);
}

/**
 * services.yaml entries (already validated by the shared reader) keyed by identity, in file
 * order. Descriptions are not carried: the canonical rendering of them belongs to the Python
 * generator, and this smoke no longer renders anything.
 */
export function servicesRegistry(entries: readonly NatsServiceEntry[]): ServicesRegistry {
  return new Map(
    entries.map((service): [string, RegistryService] => [
      service.name,
      {
        application: service.application,
        publish: new Set(service.publish),
        subscribe: new Set(service.subscribe),
      },
    ]),
  );
}

/**
 * Exactly the bytes the Python owner renders for this tree's services.yaml — the BEGIN..END
 * block, no trailing newline. The canonical form of the generated block has one owner; this
 * subprocess is how a consumer reads it without re-implementing (and drifting from) it.
 */
export function ownerGeneratedBlock(): string {
  const result = spawnSync('python3', [resolve(REPO_ROOT, GENERATOR), '--print-generated-block'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.error !== undefined) {
    throw new Error(
      `the canonical renderer ${GENERATOR} could not run: ${errorMessage(result.error)}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `the canonical renderer ${GENERATOR} failed (exit ${String(result.status)}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function countOccurrences(source: string, value: string): number {
  return source.split(value).length - 1;
}

function skipWhitespaceAndComments(source: string, start: number): number {
  let cursor = start;
  while (cursor < source.length) {
    if (/\s/.test(source.charAt(cursor))) {
      cursor += 1;
      continue;
    }
    if (source.charAt(cursor) === '#') {
      const newline = source.indexOf('\n', cursor);
      cursor = newline === -1 ? source.length : newline + 1;
      continue;
    }
    break;
  }
  return cursor;
}

function readNatsScalar(
  source: string,
  start: number,
  label: string,
): { readonly value: string; readonly end: number } {
  let cursor = skipWhitespaceAndComments(source, start);
  const quote = source.charAt(cursor);
  if (quote === '"') {
    const tokenStart = cursor;
    cursor += 1;
    let escaped = false;
    while (cursor < source.length) {
      const character = source.charAt(cursor);
      if (!escaped && character === '"') {
        const value = parseJson(source.slice(tokenStart, cursor + 1), label);
        if (typeof value !== 'string') throw new Error(`${label} must be a string`);
        return { value, end: cursor + 1 };
      }
      escaped = character === '\\' && !escaped;
      cursor += 1;
    }
    throw new Error(`${label} contains an unterminated double-quoted scalar`);
  }
  if (quote === "'") {
    cursor += 1;
    let value = '';
    while (cursor < source.length) {
      const character = source.charAt(cursor);
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
  while (cursor < source.length && !/[\s,[\]{}#]/.test(source.charAt(cursor))) cursor += 1;
  if (cursor === tokenStart) throw new Error(`${label} is missing a scalar value`);
  return { value: source.slice(tokenStart, cursor), end: cursor };
}

function parseNatsSubjectList(source: string, label: string): ReadonlySet<string> {
  const subjects: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    cursor = skipWhitespaceAndComments(source, cursor);
    while (source.charAt(cursor) === ',') cursor = skipWhitespaceAndComments(source, cursor + 1);
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

function parsePermissionList(
  userSection: string,
  permission: 'publish' | 'subscribe',
  userName: string,
): ReadonlySet<string> {
  const expression = new RegExp(
    `\\b${permission}\\s*:\\s*\\{\\s*\\ballow\\s*:\\s*\\[([\\s\\S]*?)\\]\\s*\\}`,
  );
  const match = expression.exec(userSection);
  if (match === null || match[1] === undefined) {
    throw new Error(`nats.conf user ${userName} is missing ${permission}.allow`);
  }
  return parseNatsSubjectList(match[1], `nats.conf ${userName}.${permission}`);
}

export function parseGeneratedNatsAuthorization(natsConf: string): GeneratedAuthorization {
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
  const authorization = new Map<string, GeneratedPermissions>();
  userMarkers.forEach((marker, index) => {
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
    authorization.set(serviceName, {
      publish: parsePermissionList(section, 'publish', serviceName),
      subscribe: parsePermissionList(section, 'subscribe', serviceName),
    });
  });
  return authorization;
}

function stripNatsComments(source: string): string {
  let result = '';
  let cursor = 0;
  let quote: string | null = null;
  while (cursor < source.length) {
    const current = source.charAt(cursor);
    const next = source.charAt(cursor + 1);
    if (quote !== null) {
      result += current;
      if (current === quote && source.charAt(cursor - 1) !== '\\') quote = null;
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

function assertSameSet(
  actual: ReadonlySet<string>,
  expected: ReadonlySet<string>,
  label: string,
): void {
  const missing = [...expected].filter((value) => !actual.has(value));
  const extra = [...actual].filter((value) => !expected.has(value));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${label} differs from services.yaml: missing=[${missing.join(', ')}], extra=[${extra.join(', ')}]`,
    );
  }
}

function assertRequestAndCommandBoundaries(registry: ServicesRegistry): void {
  const ownedRequestNamespaces = new Set(
    [...registry.values()].map((service) =>
      service.application.replace(/-(?:service|api|engine)$/, ''),
    ),
  );
  for (const [name, service] of registry) {
    for (const subject of service.publish) {
      if (subject.startsWith('request.')) {
        const tokens = subject.split('.');
        const namespace = tokens[1] ?? '';
        if (tokens.length < 3 || tokens.some((token) => token === '*' || token === '>')) {
          throw new Error(`${name} contains broad request grant ${subject}`);
        }
        if (!ownedRequestNamespaces.has(namespace)) {
          throw new Error(
            `${name} contains request grant in unowned request namespace ${namespace}`,
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

function requireService(
  registry: ServicesRegistry,
  name: string,
  purpose: string,
): RegistryService {
  const service = registry.get(name);
  if (service === undefined) throw new Error(`${purpose} requires the ${name} identity`);
  return service;
}

function assertRequiredMessagingGrants(registry: ServicesRegistry): void {
  const messaging = requireService(registry, 'messaging_service', 'the messaging ACL');
  const gateway = requireService(registry, 'gateway_service', 'the messaging ACL');
  if (!messaging.publish.has('events.*.MessageSent')) {
    throw new Error('messaging_service must publish events.*.MessageSent');
  }
  for (const subject of [
    'request.messaging.verifyMembership',
    'request.messaging.resolveNotificationRef',
  ]) {
    if (!gateway.publish.has(subject)) {
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

function assertMarineCredentialGrants(registry: ServicesRegistry): void {
  const purpose = 'marine credential ACL';
  const farm = requireService(registry, 'farm_service', purpose);
  const config = requireService(registry, 'config_service', purpose);
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
  if (subjectMatches('_INBOX.>', representativeReply)) {
    throw new Error('marine credential reply inbox must remain distinct from generic _INBOX');
  }
  for (const [name, service] of registry) {
    const grants = [...service.publish, ...service.subscribe];
    if (name !== 'farm_service' && name !== 'config_service') {
      const leak = grants.find(
        (grant) =>
          grant.startsWith('config.marine_credentials.') ||
          grant.startsWith('_INBOXFARMMARINECFG.') ||
          subjectMatches(grant, representativeReply),
      );
      if (leak !== undefined) {
        throw new Error(`${name} leaks the scoped marine credential authority via ${leak}`);
      }
    }
  }
  for (const grant of [...farm.publish, ...config.subscribe]) {
    if (grant.startsWith('config.marine_credentials.') && !MARINE_CREDENTIAL_SUBJECTS.has(grant)) {
      throw new Error(`marine credential ACL must use exact subjects, not ${grant}`);
    }
  }
}

function assertIncludedConfigs(includedConfigs: ReadonlyMap<string, string>): void {
  const development = includedConfigs.get('nats-tls.conf');
  const production = includedConfigs.get('nats-tls-enabled.conf');
  if (development === undefined || production === undefined) {
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

export function assertStaticAcl(
  registry: ServicesRegistry,
  authorization: GeneratedAuthorization,
  natsConf: string,
  includedConfigs: ReadonlyMap<string, string>,
  ownerBlock: string,
): void {
  if (registry.size !== authorization.size) {
    throw new Error('generated NATS authorization identity count differs from services.yaml');
  }
  for (const [name, service] of registry) {
    const generated = authorization.get(name);
    if (generated === undefined)
      throw new Error(`generated NATS authorization is missing CN=${name}`);
    assertSameSet(generated.publish, service.publish, `${name}.publish`);
    assertSameSet(generated.subscribe, service.subscribe, `${name}.subscribe`);
  }

  const canonical = `${AUTHORIZATION_ENVELOPE_PREFIX}${ownerBlock}${AUTHORIZATION_ENVELOPE_SUFFIX}`;
  const canonicalStart = natsConf.indexOf(canonical);
  if (canonicalStart === -1) {
    throw new Error(
      `nats.conf generated authorization differs from ${GENERATOR}'s rendering of services.yaml`,
    );
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

export type PemReader = (path: string, label: string) => string;

function defaultReadPem(path: string, label: string): string {
  let pem: string;
  try {
    pem = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`${label} at ${path} could not be read: ${errorMessage(error)}`);
  }
  const marker = label === 'NATS_TLS_KEY' ? 'PRIVATE KEY' : 'BEGIN CERTIFICATE';
  if (!pem.includes(marker)) {
    throw new Error(`${label} at ${path} is not valid PEM material (${marker} missing)`);
  }
  return pem;
}

export function buildNatsOptions(
  env: NodeJS.ProcessEnv = process.env,
  readPem: PemReader = defaultReadPem,
): NodeConnectionOptions {
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

type Mode = 'static' | 'live';

function parseMode(argv: readonly string[]): Mode {
  const modeIndex = argv.findIndex((arg) => arg === '--mode' || arg.startsWith('--mode='));
  if (modeIndex === -1) return 'live';
  const argument = argv[modeIndex] ?? '';
  const mode = argument.includes('=')
    ? argument.slice(argument.indexOf('=') + 1)
    : argv[modeIndex + 1];
  if (mode !== 'static' && mode !== 'live') {
    throw new Error(`unsupported --mode ${String(mode)}; expected static or live`);
  }
  return mode;
}

interface StaticInputs {
  readonly services: ServicesRegistry;
  readonly authorization: GeneratedAuthorization;
  readonly natsConf: string;
  readonly includes: ReadonlyMap<string, string>;
  /** The Python owner's rendering of this tree's services.yaml (see ownerGeneratedBlock). */
  readonly ownerBlock: string;
}

export function loadStaticInputs(): StaticInputs {
  const services = servicesRegistry(loadNatsServices());
  const natsConf = readRepoFile('infrastructure/docker/nats/nats.conf');
  const authorization = parseGeneratedNatsAuthorization(natsConf);
  const includes = new Map([
    ['nats-tls.conf', readRepoFile('infrastructure/docker/nats/nats-tls.conf')],
    ['nats-tls-enabled.conf', readRepoFile('infrastructure/docker/nats/nats-tls-enabled.conf')],
  ]);
  return { services, authorization, natsConf, includes, ownerBlock: ownerGeneratedBlock() };
}

async function main(): Promise<void> {
  const staticInputs = loadStaticInputs();
  assertStaticAcl(
    staticInputs.services,
    staticInputs.authorization,
    staticInputs.natsConf,
    staticInputs.includes,
    staticInputs.ownerBlock,
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

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`messaging-nats-acl smoke failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
