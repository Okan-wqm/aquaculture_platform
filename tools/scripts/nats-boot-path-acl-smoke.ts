/**
 * nats-boot-path-acl-smoke.ts — every NestJS service identity can run the event
 * bus boot sequence against a broker on the generated authorization.
 *
 * WHY: the ACL (infrastructure/nats/services.yaml → nats.conf) and the client
 * code that has to fit inside it are validated separately: the invariants
 * check the files, the unit tests drive the factory and the bus with mocks,
 * and CI's broker runs without the generated configuration. The first thing
 * that ever put a real certificate identity through the real boot path under
 * the real ACL was the production container. Two defects lived in that gap
 * until the 2026-09-20 outage: the scoped inbox prefix carried a trailing dot
 * (the client appends its own, so the mux inbox `_INBOX<CN>..<nuid>.*` never
 * matched the grant `_INBOX<CN>.>`), and the JetStream manager's default
 * availability probe requested `$JS.API.INFO`, which no identity is granted.
 *
 * WHAT: for each service in services.yaml whose application is a NestJS app,
 * with a certificate whose CN is that service name:
 *   1. derive the inbox prefix exactly as the connection factory does under
 *      mTLS (certificateCommonName → scopedInboxPrefix) and check the inbox the
 *      client builds from it is inside the service's SUBSCRIBE grant;
 *   2. connect with that certificate and prefix;
 *   3. run NatsEventBus.establishConnection's JetStream sequence:
 *      jetstreamManager({ checkAPI: false }) then create-or-update the three
 *      streams (STREAM.INFO → STREAM.UPDATE, or STREAM.CREATE when absent).
 * A permissions violation, a timeout or a connect failure anywhere is a
 * finding. Run through scripts/nats/boot-path-acl-smoke-harness.sh, which
 * boots the broker on the repo's nats.conf and mints the certificates.
 *
 * Environment: NATS_URL (tls://…), NATS_TLS_CA, NATS_CLIENT_CERT_DIR (holding
 * `<name>-cert.pem` / `<name>-key.pem` per service).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import {
  JetStreamApiCodes,
  JetStreamApiError,
  jetstreamManager,
  RetentionPolicy,
  StorageType,
} from '@nats-io/jetstream';
import type { JetStreamManager, StreamConfig } from '@nats-io/jetstream';
import { createInbox } from '@nats-io/nats-core';
import type { NatsConnection } from '@nats-io/nats-core';
import { connect } from '@nats-io/transport-node';
import { parse as parseYaml } from 'yaml';

import {
  certificateCommonName,
  scopedInboxPrefix,
} from '../../libs/backend-common/src/nats/nats-connection.factory';

const REPO_ROOT = resolve(__dirname, '..', '..');
const REQUEST_TIMEOUT_MS = 5_000;

interface ServiceEntry {
  readonly name: string;
  readonly application: string;
  readonly publish: readonly string[];
  readonly subscribe: readonly string[];
}

interface Finding {
  readonly service: string;
  readonly step: string;
  readonly detail: string;
}

/** The boot path's three streams; subjects mirror NatsEventBus' configs. */
const BOOT_STREAMS: readonly Pick<StreamConfig, 'name' | 'subjects'>[] = [
  { name: 'AQUACULTURE_EVENTS', subjects: ['events.>', 'commands.>', 'queries.>'] },
  { name: 'AQUACULTURE_DLQ', subjects: ['dlq.>'] },
  { name: 'AQUACULTURE_TELEMETRY', subjects: ['telemetry.>'] },
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}

function loadServices(): readonly ServiceEntry[] {
  const document: unknown = parseYaml(
    readFileSync(resolve(REPO_ROOT, 'infrastructure/nats/services.yaml'), 'utf8'),
  );
  if (typeof document !== 'object' || document === null || !('services' in document)) {
    throw new Error('services.yaml: missing `services`');
  }
  const services: unknown = document.services;
  if (!Array.isArray(services)) throw new Error('services.yaml: `services` is not a list');
  return services.map((entry: unknown): ServiceEntry => {
    if (typeof entry !== 'object' || entry === null) throw new Error('services.yaml: bad entry');
    const record = entry as Record<string, unknown>;
    const strings = (key: string): readonly string[] =>
      Array.isArray(record[key])
        ? record[key].filter((v): v is string => typeof v === 'string')
        : [];
    if (typeof record['name'] !== 'string' || typeof record['application'] !== 'string') {
      throw new Error('services.yaml: entry without name/application');
    }
    return {
      name: record['name'],
      application: record['application'],
      publish: strings('publish'),
      subscribe: strings('subscribe'),
    };
  });
}

function isNestApplication(application: string): boolean {
  return existsSync(resolve(REPO_ROOT, 'apps', application, 'src', 'app.module.ts'));
}

/** Does `subject` fall inside a `<token>.>` grant? Tokens must be non-empty. */
function grantCovers(grant: string, subject: string): boolean {
  const grantTokens = grant.split('.');
  const subjectTokens = subject.split('.');
  if (subjectTokens.some((token) => token.length === 0)) return false;
  for (let index = 0; index < grantTokens.length; index += 1) {
    const expected = grantTokens[index];
    if (expected === '>') return subjectTokens.length > index;
    if (subjectTokens.length <= index) return false;
    if (expected !== '*' && expected !== subjectTokens[index]) return false;
  }
  return grantTokens.length === subjectTokens.length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * A JetStream API answer proves the request/reply path: the publish and the
 * inbox subscription both passed the ACL and the broker replied. A permissions
 * violation or a timeout surfaces as a different error class.
 */
function isJetStreamApiAnswer(error: unknown): error is JetStreamApiError {
  return error instanceof JetStreamApiError;
}

function isStreamNotFound(error: unknown): boolean {
  return isJetStreamApiAnswer(error) && error.code === JetStreamApiCodes.StreamNotFound;
}

async function createOrUpdateStreams(
  manager: JetStreamManager,
  findings: Finding[],
  service: string,
): Promise<void> {
  for (const stream of BOOT_STREAMS) {
    const config: Partial<StreamConfig> & Pick<StreamConfig, 'name'> = {
      ...stream,
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      num_replicas: 1,
    };
    try {
      await manager.streams.info(stream.name);
    } catch (error: unknown) {
      if (!isStreamNotFound(error)) {
        findings.push({ service, step: `STREAM.INFO ${stream.name}`, detail: errorMessage(error) });
        continue;
      }
      try {
        await manager.streams.add(config);
      } catch (createError: unknown) {
        findings.push({
          service,
          step: `STREAM.CREATE ${stream.name}`,
          detail: errorMessage(createError),
        });
      }
      continue;
    }
    try {
      await manager.streams.update(stream.name, config);
    } catch (error: unknown) {
      findings.push({ service, step: `STREAM.UPDATE ${stream.name}`, detail: errorMessage(error) });
    }
  }
}

async function smokeService(
  service: ServiceEntry,
  env: { url: string; ca: string; certDir: string },
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const certPath = resolve(env.certDir, `${service.name}-cert.pem`);
  const keyPath = resolve(env.certDir, `${service.name}-key.pem`);
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    return [
      { service: service.name, step: 'certificate', detail: `missing ${certPath} / ${keyPath}` },
    ];
  }

  // 1. The factory's own derivation, from the certificate, against the grant.
  const identity = certificateCommonName(readFileSync(certPath, 'utf8'), certPath);
  if (identity !== service.name) {
    findings.push({
      service: service.name,
      step: 'certificate CN',
      detail: `CN=${identity} ≠ ${service.name}`,
    });
  }
  const prefix = scopedInboxPrefix(identity);
  const muxInbox = `${createInbox(prefix)}.*`;
  const inboxGrants = service.subscribe.filter((grant) => grant.startsWith('_INBOX'));
  if (!inboxGrants.some((grant) => grantCovers(grant, muxInbox))) {
    findings.push({
      service: service.name,
      step: 'inbox grant',
      detail: `client mux inbox ${muxInbox} is outside subscribe grants [${inboxGrants.join(', ')}]`,
    });
  }

  // 2. + 3. The live boot sequence.
  let connection: NatsConnection;
  try {
    connection = await connect({
      servers: env.url,
      name: `boot-path-smoke-${service.name}`,
      inboxPrefix: prefix,
      timeout: REQUEST_TIMEOUT_MS,
      reconnect: false,
      tls: { caFile: env.ca, certFile: certPath, keyFile: keyPath },
    });
  } catch (error: unknown) {
    findings.push({ service: service.name, step: 'connect', detail: errorMessage(error) });
    return findings;
  }
  try {
    const manager = await jetstreamManager(connection, {
      checkAPI: false,
      timeout: REQUEST_TIMEOUT_MS,
    });
    if (service.publish.includes('$JS.API.STREAM.INFO.>')) {
      await createOrUpdateStreams(manager, findings, service.name);
    } else {
      // No stream rights (e.g. an operator tool): the request/reply path is
      // still proven by a CONSUMER.INFO round trip that must come back as a
      // JetStream API answer, not a permissions violation or a timeout.
      try {
        await manager.consumers.info('AQUACULTURE_DLQ', 'boot-path-smoke-absent');
      } catch (error: unknown) {
        if (!isJetStreamApiAnswer(error)) {
          findings.push({
            service: service.name,
            step: 'CONSUMER.INFO round trip',
            detail: errorMessage(error),
          });
        }
      }
    }
  } catch (error: unknown) {
    findings.push({ service: service.name, step: 'jetstreamManager', detail: errorMessage(error) });
  } finally {
    await connection.close();
  }
  return findings;
}

async function main(): Promise<number> {
  const env = {
    url: requireEnv('NATS_URL'),
    ca: requireEnv('NATS_TLS_CA'),
    certDir: requireEnv('NATS_CLIENT_CERT_DIR'),
  };
  if (!env.url.startsWith('tls://'))
    throw new Error('NATS_URL must be tls:// — the ACL is certificate-mapped');

  const services = loadServices();
  const findings: Finding[] = [];
  let checked = 0;
  for (const service of services) {
    if (!isNestApplication(service.application)) {
      process.stdout.write(
        `skip  ${service.name.padEnd(24)} (${service.application} is not a NestJS application)\n`,
      );
      continue;
    }
    checked += 1;
    const serviceFindings = await smokeService(service, env);
    findings.push(...serviceFindings);
    process.stdout.write(`${serviceFindings.length === 0 ? 'ok   ' : 'FAIL '} ${service.name}\n`);
  }
  for (const finding of findings) {
    process.stderr.write(`  ${finding.service}: ${finding.step} — ${finding.detail}\n`);
  }
  process.stdout.write(`boot-path ACL smoke: ${checked} identities, ${findings.length} findings\n`);
  return findings.length === 0 && checked > 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  },
);
