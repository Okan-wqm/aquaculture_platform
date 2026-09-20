/**
 * The reply inbox a client subscribes to must be the one services.yaml grants
 * the identity the broker sees. Under mTLS that identity is the certificate
 * CN (verify_and_map, ADR-015) — not whatever label the caller passed as
 * `serviceName`. The event bus passed `aquaculture-<service>` and the gateway
 * bridges passed `gateway-api-websocket-bridge`; both produced inboxes the
 * broker never granted, and every JetStream request failed with
 * "Permissions Violation for Subscription" the first time production loaded
 * the SSoT ACL (2026-09-19).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildNatsConnectionOptions,
  certificateCommonName,
  scopedInboxPrefix,
} from '../nats-connection.factory';

/**
 * A self-signed, public test certificate whose only property under test is
 * its subject: CN=sensor_service. Inline (not a .pem fixture) because the
 * repository ignores *.pem, which is right for real material.
 */
const FIXTURE_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBtjCCAVugAwIBAgIUJdi4ZIdhlJEUNvPzBYG8fRY40EIwCgYIKoZIzj0EAwIw
LzEXMBUGA1UEAwwOc2Vuc29yX3NlcnZpY2UxFDASBgNVBAoMC2FxdWFjdWx0dXJl
MCAXDTI2MDkyMDAwMjIzNFoYDzIxMjYwODI3MDAyMjM0WjAvMRcwFQYDVQQDDA5z
ZW5zb3Jfc2VydmljZTEUMBIGA1UECgwLYXF1YWN1bHR1cmUwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAATQbTt7T3D+HlAu0nUCRLxPoglniIWaSynS90VlYwmzD1/f
CrDDsBhQrrzayEAfgVr3JwBWVzGM1RVebnoFevWjo1MwUTAdBgNVHQ4EFgQUdXnV
G5qSkZ2C7HV7q9u0A3PczTYwHwYDVR0jBBgwFoAUdXnVG5qSkZ2C7HV7q9u0A3Pc
zTYwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNJADBGAiEA0M/Ik2YBYmdG
3TKaS9tI5RE3SV3Tf8x8WP0Avad7iagCIQCZxQRnJvJ68fPNPj/uQKW2A0AJzqy5
CH/O4NGlZ41Y7A==
-----END CERTIFICATE-----`;
/** The factory validates key material by PEM markers only; parsing is the transport's job. */
const MARKER_ONLY_KEY = '-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n';

const ENV_KEYS = [
  'NATS_URL',
  'NATS_TLS_ENABLED',
  'NATS_TLS_CA',
  'NATS_TLS_CERT',
  'NATS_TLS_KEY',
  'NATS_AUTH_USER',
  'NATS_AUTH_PASS',
  'NATS_AUTH_TOKEN',
  'NODE_ENV',
] as const;

describe('buildNatsConnectionOptions — scoped reply inbox', () => {
  const saved = new Map<string, string | undefined>();
  let dir: string;

  beforeEach(() => {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    dir = mkdtempSync(join(tmpdir(), 'nats-factory-inbox-'));
    const certPem = FIXTURE_CERT_PEM;
    writeFileSync(join(dir, 'ca.pem'), certPem);
    writeFileSync(join(dir, 'client-cert.pem'), certPem);
    writeFileSync(join(dir, 'client-key.pem'), MARKER_ONLY_KEY);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  });

  it('reads the identity out of the client certificate CN', () => {
    expect(certificateCommonName(FIXTURE_CERT_PEM, '<inline>')).toBe('sensor_service');
    expect(scopedInboxPrefix('sensor_service')).toBe('_INBOXSENSOR_SERVICE.');
    expect(scopedInboxPrefix('auth-service')).toBe('_INBOXAUTH_SERVICE.');
  });

  it('under mTLS the inbox prefix follows the certificate CN, not the caller label', () => {
    process.env['NATS_URL'] = 'tls://nats:4222';
    process.env['NATS_TLS_ENABLED'] = 'true';
    process.env['NATS_TLS_CA'] = join(dir, 'ca.pem');
    process.env['NATS_TLS_CERT'] = join(dir, 'client-cert.pem');
    process.env['NATS_TLS_KEY'] = join(dir, 'client-key.pem');
    delete process.env['NATS_AUTH_USER'];
    delete process.env['NATS_AUTH_PASS'];
    delete process.env['NATS_AUTH_TOKEN'];

    const options = buildNatsConnectionOptions('aquaculture-sensor-service');

    expect(options.authMode).toBe('mtls-cert');
    expect(options.name).toBe('aquaculture-sensor-service');
    expect(options.inboxPrefix).toBe('_INBOXSENSOR_SERVICE.');
  });

  it('without a client certificate the caller name still scopes the inbox (dev / CI)', () => {
    process.env['NATS_URL'] = 'nats://localhost:4222';
    process.env['NATS_TLS_ENABLED'] = 'false';
    process.env['NODE_ENV'] = 'test';
    for (const key of ['NATS_TLS_CA', 'NATS_TLS_CERT', 'NATS_TLS_KEY', 'NATS_AUTH_TOKEN']) {
      Reflect.deleteProperty(process.env, key);
    }
    process.env['NATS_AUTH_USER'] = 'dev';
    process.env['NATS_AUTH_PASS'] = 'dev';

    expect(buildNatsConnectionOptions('sensor-service').inboxPrefix).toBe('_INBOXSENSOR_SERVICE.');
  });

  it('refuses a client certificate without a CN', () => {
    expect(() => certificateCommonName('not a certificate', '/x/cert.pem')).toThrow(
      /could not be parsed/,
    );
  });
});
