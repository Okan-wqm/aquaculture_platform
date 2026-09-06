import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createInbox } from '@nats-io/nats-core';
import { parse } from 'yaml';

import { buildNatsConnectionOptions } from '../nats-connection.factory';

interface RegisteredService {
  name: string;
  application: string;
  subscribe: string[];
}

const registry = parse(
  readFileSync(
    resolve(__dirname, '../../../../../infrastructure/nats/services.yaml'),
    'utf8',
  ),
) as { services: RegisteredService[] };

describe('NATS reply identity follows the mounted certificate', () => {
  let directory: string;
  const certificates = new Map<string, { cert: string; key: string }>();

  function createCertificate(label: string, subject: string): void {
    const cert = join(directory, `${label}-cert.pem`);
    const key = join(directory, `${label}-key.pem`);
    // Ephemeral test keys are generated only by the hosted test runner and
    // removed after the suite. No production certificate or key is a fixture.
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:P-256',
        '-nodes',
        '-days',
        '1',
        '-subj',
        subject,
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdio: 'pipe' },
    );
    certificates.set(label, { cert, key });
  }

  function useCertificate(identity: string): void {
    const certificate = certificates.get(identity);
    if (!certificate) throw new Error('Test certificate was not created');
    const environment = { ...process.env };
    for (const name of Object.keys(environment)) {
      if (name.startsWith('NATS_')) delete environment[name];
    }
    jest.replaceProperty(process, 'env', {
      ...environment,
      NODE_ENV: 'production',
      NATS_URL: 'tls://nats:4222',
      NATS_TLS_ENABLED: 'true',
      NATS_TLS_CA: certificate.cert,
      NATS_TLS_CERT: certificate.cert,
      NATS_TLS_KEY: certificate.key,
    });
  }

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'nats-inbox-identity-'));
    for (const service of registry.services) {
      createCertificate(service.name, `/CN=${service.name}`);
    }
    createCertificate('missing-cn', '/O=unit-test');
    createCertificate('ambiguous-cn', '/CN=config_service/CN=auth_service');
    createCertificate('noncanonical-dn', '/CN=config_service/O=unit-test');
    createCertificate('invalid-cn', '/CN=config.service');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it.each(registry.services)(
    '$application uses an SDK inbox covered by its services.yaml certificate ACL',
    (service) => {
      useCertificate(service.name);
      const options = buildNatsConnectionOptions(`aquaculture-${service.application}`);
      const inbox = createInbox(options.inboxPrefix);
      const [prefix, uniqueSuffix, ...unexpectedSegments] = inbox.split('.');

      expect(options.name).toBe(`aquaculture-${service.application}`);
      expect(options.authMode).toBe('mtls-cert');
      expect(service.subscribe).toContain(`${prefix}.>`);
      expect(options.inboxPrefix).toBe(prefix);
      expect(uniqueSuffix).toBeTruthy();
      expect(unexpectedSegments).toEqual([]);
      expect(createInbox(options.inboxPrefix)).not.toBe(inbox);
    },
  );

  it.each([undefined, 'aquaculture-config-service', 'replica-42', 'auth-service'])(
    'client display name %s cannot select another certificate identity',
    (displayName) => {
      useCertificate('config_service');
      expect(buildNatsConnectionOptions(displayName).inboxPrefix).toBe('_INBOXCONFIG_SERVICE');
    },
  );

  it('cert-only options never include competing CONNECT credentials', () => {
    useCertificate('config_service');
    process.env['NATS_AUTH_USER'] = 'unrelated-user';
    process.env['NATS_AUTH_PASS'] = 'test-password';
    process.env['NATS_AUTH_TOKEN'] = 'test-token';
    const options = buildNatsConnectionOptions('replica-42');
    expect(options.user).toBeUndefined();
    expect(options.pass).toBeUndefined();
    expect(options.token).toBeUndefined();
    expect(options.inboxPrefix).toBe('_INBOXCONFIG_SERVICE');
  });

  it.each(['missing-cn', 'ambiguous-cn', 'noncanonical-dn', 'invalid-cn'])(
    'rejects %s instead of inventing a reply identity',
    (identity) => {
      useCertificate(identity);
      expect(() => buildNatsConnectionOptions('config-service')).toThrow(
        'one canonical service CN',
      );
    },
  );

  it('rejects an invalid certificate without echoing certificate contents', () => {
    useCertificate('config_service');
    const invalidPath = join(directory, 'invalid-cert.pem');
    writeFileSync(invalidPath, '-----BEGIN CERTIFICATE-----\nPRIVATE_SENTINEL\n');
    process.env['NATS_TLS_CERT'] = invalidPath;
    expect(() => buildNatsConnectionOptions('config-service')).toThrow(
      '[nats-connection.factory] NATS_TLS_CERT must contain a valid X.509 certificate.',
    );
  });

  it('rejects a missing certificate before producing connection options', () => {
    useCertificate('config_service');
    process.env['NATS_TLS_CERT'] = join(directory, 'does-not-exist.pem');
    expect(() => buildNatsConnectionOptions('config-service')).toThrow(
      'mTLS client cert/key could not be read',
    );
  });

  it.each(['false', 'true'])(
    'requires a CA for mTLS even when insecure opt-in is %s',
    (insecureAllow) => {
      useCertificate('config_service');
      delete process.env['NATS_TLS_CA'];
      process.env['NATS_TLS_INSECURE_ALLOW'] = insecureAllow;
      process.env['NATS_AUTH_TOKEN'] = 'competing-token';
      expect(() => buildNatsConnectionOptions('config-service')).toThrow(
        'mTLS requires NATS_TLS_CA and forbids NATS_TLS_INSECURE_ALLOW=true',
      );
    },
  );

  it('rejects the insecure flag in mTLS mode even when the CA is present', () => {
    useCertificate('config_service');
    process.env['NATS_TLS_INSECURE_ALLOW'] = 'true';
    expect(() => buildNatsConnectionOptions('config-service')).toThrow(
      'mTLS requires NATS_TLS_CA and forbids NATS_TLS_INSECURE_ALLOW=true',
    );
  });

  it('preserves non-mTLS development TLS configuration without a custom CA', () => {
    useCertificate('config_service');
    process.env['NODE_ENV'] = 'test';
    delete process.env['NATS_TLS_CA'];
    delete process.env['NATS_TLS_CERT'];
    delete process.env['NATS_TLS_KEY'];
    process.env['NATS_TLS_INSECURE_ALLOW'] = 'true';
    const options = buildNatsConnectionOptions('development-client');
    expect(options.authMode).toBe('none');
    expect(options.inboxPrefix).toBeUndefined();
    expect(options.tls).toBeUndefined();
  });
});
