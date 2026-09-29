/**
 * buildNatsConnectionOptions — reply-inbox isolation (ORPHAN-CRITICAL-402).
 *
 * The factory is the ONE place a NATS connection is described on this platform
 * (ADR-015), so it is also the only place that can guarantee no connection ever
 * falls back to nats.js's shared `_INBOX` default. These tests pin the
 * derivation to the mTLS certificate CN — the same string the broker's
 * `authorization.users[]` block is keyed on — so the prefix a client subscribes
 * and the grant the broker holds cannot drift apart.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildNatsConnectionOptions } from '../nats-connection.factory';

interface CertPair {
  certPath: string;
  keyPath: string;
}

let workDir: string;
let caPath: string;
const issued = new Map<string, CertPair>();

function issueCert(commonName: string): CertPair {
  const cached = issued.get(commonName);
  if (cached) return cached;
  const keyPath = join(workDir, `${commonName}-key.pem`);
  const certPath = join(workDir, `${commonName}-cert.pem`);
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '2',
      '-subj',
      `/CN=${commonName}`,
    ],
    { stdio: 'ignore' },
  );
  const pair: CertPair = { certPath, keyPath };
  issued.set(commonName, pair);
  return pair;
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'nats-factory-'));
  // The CA bundle only has to be a readable PEM certificate for the factory's
  // shape validation; issuing a throwaway self-signed cert is enough.
  const ca = issueCert('Aquaculture Internal CA test');
  caPath = join(workDir, 'ca-cert.pem');
  writeFileSync(caPath, execFileSync('cat', [ca.certPath]));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const ENV_KEYS = [
  'NATS_URL',
  'NATS_TLS_ENABLED',
  'NATS_TLS_CA',
  'NATS_TLS_CERT',
  'NATS_TLS_KEY',
  'NATS_TLS_INSECURE_ALLOW',
  'NATS_AUTH_USER',
  'NATS_AUTH_PASS',
  'NATS_AUTH_TOKEN',
  'NODE_ENV',
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const value = savedEnv[k];
    if (value === undefined) delete process.env[k];
    else process.env[k] = value;
  }
});

function useMtls(commonName: string): void {
  const { certPath, keyPath } = issueCert(commonName);
  process.env['NATS_URL'] = 'tls://nats:4222';
  process.env['NATS_TLS_ENABLED'] = 'true';
  process.env['NATS_TLS_CA'] = caPath;
  process.env['NATS_TLS_CERT'] = certPath;
  process.env['NATS_TLS_KEY'] = keyPath;
}

describe('buildNatsConnectionOptions — per-service reply inbox', () => {
  it('derives the inbox prefix from the mTLS certificate CN (cert IS identity)', () => {
    useMtls('farm_service');

    const options = buildNatsConnectionOptions('gateway-api-farm-bridge');

    expect(options.authMode).toBe('mtls-cert');
    // NOT the client `name` — the ACL is keyed on the certificate CN, and one
    // certificate backs several differently-named connections per runtime.
    expect(options.inboxPrefix).toBe('_INBOX_farm_service');
  });

  it('gives every certificate identity a DISTINCT first token', () => {
    useMtls('auth_service');
    const auth = buildNatsConnectionOptions('auth-service');
    useMtls('billing_service');
    const billing = buildNatsConnectionOptions('billing-service');

    expect(auth.inboxPrefix).not.toBe(billing.inboxPrefix);
    expect(auth.inboxPrefix.split('.')[0]).not.toBe(billing.inboxPrefix.split('.')[0]);
  });

  it('never returns the shared `_INBOX` default in any auth mode', () => {
    const modes: Array<() => void> = [
      () => useMtls('sensor_service'),
      () => {
        process.env['NATS_URL'] = 'nats://nats:4222';
        process.env['NATS_AUTH_USER'] = 'messaging_service';
        process.env['NATS_AUTH_PASS'] = 'pw';
      },
      () => {
        process.env['NATS_URL'] = 'nats://nats:4222';
        process.env['NATS_AUTH_TOKEN'] = 'tok';
      },
      () => {
        process.env['NATS_URL'] = 'nats://localhost:4222';
      },
    ];

    for (const setup of modes) {
      for (const k of ENV_KEYS) delete process.env[k];
      setup();
      const options = buildNatsConnectionOptions('hydroponics-service');
      expect(options.inboxPrefix).not.toBe('_INBOX');
      expect(options.inboxPrefix.split('.')[0]).not.toBe('_INBOX');
      expect(options.inboxPrefix.startsWith('_INBOX_')).toBe(true);
    }
  });

  it('prefers the CONNECT-frame user over the client name when there is no cert', () => {
    process.env['NATS_URL'] = 'nats://nats:4222';
    process.env['NATS_AUTH_USER'] = 'messaging_service';
    process.env['NATS_AUTH_PASS'] = 'pw';

    // The broker keys its ACL on the authenticated user, not on `name`.
    expect(buildNatsConnectionOptions('messaging-worker-7').inboxPrefix).toBe(
      '_INBOX_messaging_service',
    );
  });

  it('refuses to build a connection with no derivable identity', () => {
    process.env['NATS_URL'] = 'nats://localhost:4222';

    expect(() => buildNatsConnectionOptions()).toThrow(/reply-inbox/i);
  });

  it('loads the client certificate even when the CA is bypassed for local dev', () => {
    const { certPath, keyPath } = issueCert('alert_engine');
    process.env['NATS_URL'] = 'tls://nats:4222';
    process.env['NATS_TLS_ENABLED'] = 'true';
    process.env['NATS_TLS_INSECURE_ALLOW'] = 'true';
    process.env['NATS_TLS_CERT'] = certPath;
    process.env['NATS_TLS_KEY'] = keyPath;

    const options = buildNatsConnectionOptions('alert-engine');

    // Pre-cure this path advertised authMode 'mtls-cert' while silently
    // omitting the client cert from the TLS options, so the connection was not
    // actually mTLS and had no identity to derive an inbox from.
    expect(options.tls?.cert).toContain('BEGIN CERTIFICATE');
    expect(options.tls?.key).toContain('PRIVATE KEY');
    expect(options.inboxPrefix).toBe('_INBOX_alert_engine');
  });
});
