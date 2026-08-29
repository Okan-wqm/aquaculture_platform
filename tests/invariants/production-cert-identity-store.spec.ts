import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import yaml from 'js-yaml';

jest.setTimeout(180_000);

const REPO_ROOT = resolve(__dirname, '..', '..');
const GENERATOR_PATH = join(REPO_ROOT, 'infrastructure/docker/scripts/generate-internal-certs.sh');
const COMPOSE_PATH = join(REPO_ROOT, 'docker-compose.droplet.yml');
const CERTS_PREFIX = '${DEPLOY_CERTS_DIR:-./certs}';

interface ComposeService {
  readonly environment?: Record<string, string>;
  readonly volumes?: readonly string[];
}

interface ComposeDocument {
  readonly services?: Record<string, ComposeService>;
}

const EXPECTED_NATS_IDENTITIES: Readonly<Record<string, string>> = {
  'gateway-api': 'gateway_service',
  'auth-service': 'auth_service',
  'farm-service': 'farm_service',
  'sensor-service': 'sensor_service',
  'admin-api-service': 'gateway_service',
  'alert-engine': 'alert_engine',
  'billing-service': 'billing_service',
  'hr-service': 'hr_service',
  'hydroponics-service': 'hydroponics_service',
  'notification-service': 'notification_service',
  'observability-service': 'observability_service',
  'config-service': 'config_service',
  'event-store-service': 'event_store_service',
  'messaging-service': 'messaging_service',
  'ai-service': 'ai_service',
};

function runGenerator(
  certsDirectory: string,
  environment: Readonly<Record<string, string>> = {},
): SpawnSyncReturns<string> {
  return spawnSync('/bin/bash', [GENERATOR_PATH], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LC_ALL: 'C',
      DEPLOY_CERTS_DIR: certsDirectory,
      ...environment,
    },
  });
}

function runAssetValidator(
  certsDirectory: string,
  assetPath: string,
  expectedMode: '0600' | '0644',
): SpawnSyncReturns<string> {
  const generator = readFileSync(GENERATOR_PATH, 'utf8');
  const generationStart = generator.indexOf(
    '\necho "=== Generating Internal TLS Certificates ==="',
  );
  if (generationStart < 0) throw new Error('certificate generator validation boundary is missing');
  const validationHarness = [
    generator.slice(0, generationStart),
    `validate_existing_certificate_asset "\${ASSET_PATH}" ${expectedMode} 'fixture asset'`,
  ].join('\n');
  return spawnSync('/bin/bash', ['-c', validationHarness], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      LC_ALL: 'C',
      DEPLOY_CERTS_DIR: certsDirectory,
      ASSET_PATH: assetPath,
    },
  });
}

function runClientSetValidator(
  certsDirectory: string,
  keyPath: string,
  certificatePath: string,
  expectedIdentity: string,
): SpawnSyncReturns<string> {
  const generator = readFileSync(GENERATOR_PATH, 'utf8');
  const generationStart = generator.indexOf(
    '\necho "=== Generating Internal TLS Certificates ==="',
  );
  if (generationStart < 0) throw new Error('certificate generator validation boundary is missing');
  const validationHarness = [
    generator.slice(0, generationStart),
    'validate_existing_client_set "${KEY_PATH}" "${CERTIFICATE_PATH}" "CN=${EXPECTED_IDENTITY}" "fixture client"',
  ].join('\n');
  return spawnSync('/bin/bash', ['-c', validationHarness], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      LC_ALL: 'C',
      DEPLOY_CERTS_DIR: certsDirectory,
      KEY_PATH: keyPath,
      CERTIFICATE_PATH: certificatePath,
      EXPECTED_IDENTITY: expectedIdentity,
    },
  });
}

function runCanonicalCaCopyValidator(
  certsDirectory: string,
  caPath: string,
): SpawnSyncReturns<string> {
  const generator = readFileSync(GENERATOR_PATH, 'utf8');
  const generationStart = generator.indexOf(
    '\necho "=== Generating Internal TLS Certificates ==="',
  );
  if (generationStart < 0) throw new Error('certificate generator validation boundary is missing');
  const validationHarness = [
    generator.slice(0, generationStart),
    'validate_canonical_ca_copy "${CA_PATH}" "fixture CA copy"',
  ].join('\n');
  return spawnSync('/bin/bash', ['-c', validationHarness], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      LC_ALL: 'C',
      DEPLOY_CERTS_DIR: certsDirectory,
      CA_PATH: caPath,
    },
  });
}

function runOpenSsl(args: readonly string[]): void {
  const result = spawnSync('/usr/bin/openssl', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
  });
  if (result.status !== 0) {
    throw new Error(`OpenSSL fixture generation failed: ${result.stderr}`);
  }
}

function generateAlternateClientIdentity(
  directory: string,
  identity: string,
): {
  readonly caCertificate: string;
  readonly clientCertificate: string;
  readonly clientKey: string;
} {
  const caKey = join(directory, 'alternate-ca-key.pem');
  const caCertificate = join(directory, 'alternate-ca-cert.pem');
  const clientKey = join(directory, 'alternate-client-key.pem');
  const clientRequest = join(directory, 'alternate-client.csr');
  const clientCertificate = join(directory, 'alternate-client-cert.pem');
  runOpenSsl(['genrsa', '-out', caKey, '2048']);
  runOpenSsl([
    'req',
    '-new',
    '-x509',
    '-days',
    '3650',
    '-key',
    caKey,
    '-out',
    caCertificate,
    '-subj',
    '/CN=Aquaculture Internal CA',
  ]);
  runOpenSsl(['genrsa', '-out', clientKey, '2048']);
  runOpenSsl(['req', '-new', '-key', clientKey, '-out', clientRequest, '-subj', `/CN=${identity}`]);
  runOpenSsl([
    'x509',
    '-req',
    '-days',
    '365',
    '-in',
    clientRequest,
    '-CA',
    caCertificate,
    '-CAkey',
    caKey,
    '-set_serial',
    '0x1234567890abcdef',
    '-out',
    clientCertificate,
  ]);
  chmodSync(caCertificate, 0o644);
  chmodSync(clientKey, 0o644);
  chmodSync(clientCertificate, 0o644);
  return { caCertificate, clientCertificate, clientKey };
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function expectFailure(result: SpawnSyncReturns<string>, fragment: string): void {
  expect(result.status).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toContain(fragment);
}

function compose(): ComposeDocument {
  return yaml.load(readFileSync(COMPOSE_PATH, 'utf8')) as ComposeDocument;
}

describe('production certificate identity store', () => {
  it('generates real identities idempotently and rejects metadata or cryptographic relabeling', () => {
    const root = mkdtempSync(join(tmpdir(), 'aqua-cert-identity-store-'));
    const certs = join(root, 'certs');
    mkdirSync(certs, { mode: 0o755 });
    const generate = (): SpawnSyncReturns<string> => runGenerator(certs);

    try {
      const generated = generate();
      expect({ status: generated.status, stderr: generated.stderr }).toEqual({
        status: 0,
        stderr: '',
      });
      for (const directory of [
        certs,
        join(certs, 'ca'),
        join(certs, 'nats'),
        join(certs, 'nats/clients'),
        join(certs, 'redis'),
        join(certs, 'postgres'),
      ]) {
        expect({
          directory,
          mode: mode(directory),
          symlink: lstatSync(directory).isSymbolicLink(),
        }).toEqual({ directory, mode: 0o700, symlink: false });
      }

      const skipped = generate();
      expect({ status: skipped.status, stderr: skipped.stderr }).toEqual({ status: 0, stderr: '' });
      expect(skipped.stdout).toContain('[skip] CA');
      expect(skipped.stdout).toContain('[skip] nats');
      expect(skipped.stdout).toContain('[skip] redis');
      expect(skipped.stdout).toContain('[skip] postgres');
      expect(skipped.stdout).toContain('[skip] auth_service client');
      expect(skipped.stdout).toContain('[skip] nats client (legacy shared)');

      const configCertificate = join(certs, 'nats/clients/config_service-cert.pem');
      const configKey = join(certs, 'nats/clients/config_service-key.pem');
      const configCertificateBytes = readFileSync(configCertificate);
      const configKeyBytes = readFileSync(configKey);
      copyFileSync(join(certs, 'nats/clients/gateway_service-cert.pem'), configCertificate);
      expectFailure(generate(), "does not match 'CN=config_service'");
      writeFileSync(configCertificate, configCertificateBytes, { mode: 0o644 });
      chmodSync(configCertificate, 0o644);

      copyFileSync(join(certs, 'nats/clients/gateway_service-key.pem'), configKey);
      expectFailure(
        runClientSetValidator(certs, configKey, configCertificate, 'config_service'),
        'fixture client certificate and private key do not match',
      );
      writeFileSync(configKey, configKeyBytes, { mode: 0o644 });
      chmodSync(configKey, 0o644);

      const alternate = generateAlternateClientIdentity(root, 'config_service');
      copyFileSync(alternate.clientCertificate, configCertificate);
      copyFileSync(alternate.clientKey, configKey);
      expectFailure(
        runClientSetValidator(certs, configKey, configCertificate, 'config_service'),
        'fixture client certificate is not signed by the canonical CA',
      );
      writeFileSync(configCertificate, configCertificateBytes, { mode: 0o644 });
      writeFileSync(configKey, configKeyBytes, { mode: 0o644 });
      chmodSync(configCertificate, 0o644);
      chmodSync(configKey, 0o644);

      const natsCa = join(certs, 'nats/ca-cert.pem');
      const natsCaBytes = readFileSync(natsCa);
      copyFileSync(alternate.caCertificate, natsCa);
      expectFailure(
        runCanonicalCaCopyValidator(certs, natsCa),
        'does not exactly match the canonical CA certificate',
      );
      writeFileSync(natsCa, natsCaBytes, { mode: 0o644 });
      chmodSync(natsCa, 0o644);

      unlinkSync(configCertificate);
      expectFailure(
        runClientSetValidator(certs, configKey, configCertificate, 'config_service'),
        'fixture client certificate is not a regular non-symlink file',
      );
      writeFileSync(configCertificate, configCertificateBytes, { mode: 0o644 });
      chmodSync(configCertificate, 0o644);

      const caKey = join(certs, 'ca/ca-key.pem');
      chmodSync(caKey, 0o644);
      expectFailure(runAssetValidator(certs, caKey, '0600'), 'mode 644 does not match 600');
      chmodSync(caKey, 0o600);

      const serverCertificate = join(certs, 'nats/nats-cert.pem');
      const serverCertificateBytes = readFileSync(serverCertificate);
      writeFileSync(serverCertificate, Buffer.alloc(0), { mode: 0o644 });
      expectFailure(runAssetValidator(certs, serverCertificate, '0644'), 'fixture asset is empty');
      writeFileSync(serverCertificate, serverCertificateBytes, { mode: 0o644 });

      const serviceKey = join(certs, 'nats/clients/auth_service-key.pem');
      const serviceKeyOriginal = `${serviceKey}.original`;
      renameSync(serviceKey, serviceKeyOriginal);
      linkSync(serviceKeyOriginal, serviceKey);
      expectFailure(
        runAssetValidator(certs, serviceKey, '0644'),
        'must have exactly one hard link',
      );
      unlinkSync(serviceKey);
      renameSync(serviceKeyOriginal, serviceKey);

      const legacyCertificate = join(certs, 'nats/client-cert.pem');
      const legacyCertificateOriginal = `${legacyCertificate}.original`;
      renameSync(legacyCertificate, legacyCertificateOriginal);
      symlinkSync(legacyCertificateOriginal, legacyCertificate);
      expectFailure(
        runAssetValidator(certs, legacyCertificate, '0644'),
        'not a regular non-symlink file',
      );
      unlinkSync(legacyCertificate);
      renameSync(legacyCertificateOriginal, legacyCertificate);

      const postgresCa = join(certs, 'postgres/ca-cert.pem');
      const postgresCaBytes = readFileSync(postgresCa);
      unlinkSync(postgresCa);
      expectFailure(runAssetValidator(certs, postgresCa, '0644'), 'not a regular non-symlink file');
      writeFileSync(postgresCa, postgresCaBytes, { mode: 0o644 });
      chmodSync(postgresCa, 0o644);

      const serverAlias = join(certs, 'postgres/server.crt');
      const hardLinkVictim = join(certs, 'postgres/hard-link-victim');
      unlinkSync(serverAlias);
      writeFileSync(hardLinkVictim, 'must-remain-unchanged\n', { mode: 0o600 });
      linkSync(hardLinkVictim, serverAlias);
      expect(statSync(hardLinkVictim).nlink).toBe(2);
      const hardLinkReplacement = generate();
      expect({ status: hardLinkReplacement.status, stderr: hardLinkReplacement.stderr }).toEqual({
        status: 0,
        stderr: '',
      });
      expect(readFileSync(hardLinkVictim, 'utf8')).toBe('must-remain-unchanged\n');
      expect(statSync(hardLinkVictim).nlink).toBe(1);
      expect(lstatSync(serverAlias).isSymbolicLink()).toBe(true);
      expect(readlinkSync(serverAlias)).toBe('postgres-cert.pem');

      unlinkSync(serverAlias);
      mkdirSync(serverAlias, { mode: 0o700 });
      const directoryReplacement = generate();
      expect(directoryReplacement.status).not.toBe(0);
      expect(lstatSync(serverAlias).isDirectory()).toBe(true);
      expect(readdirSync(serverAlias)).toEqual([]);
      expect(
        readdirSync(join(certs, 'postgres')).filter((entry) =>
          entry.startsWith('.postgres-alias.'),
        ),
      ).toEqual([]);
      rmSync(serverAlias, { recursive: true });
      const repairedAlias = generate();
      expect({ status: repairedAlias.status, stderr: repairedAlias.stderr }).toEqual({
        status: 0,
        stderr: '',
      });
      expect(readlinkSync(serverAlias)).toBe('postgres-cert.pem');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('publishes no canonical server member when OpenSSL fails during staged generation', () => {
    const root = mkdtempSync(join(tmpdir(), 'aqua-cert-publication-failure-'));
    const certs = join(root, 'certs');
    const fakeBin = join(root, 'bin');
    const fakeOpenSsl = join(fakeBin, 'openssl');
    mkdirSync(fakeBin, { mode: 0o700 });
    writeFileSync(
      fakeOpenSsl,
      [
        '#!/bin/bash',
        'set -euo pipefail',
        'if [ "${1:-}" = x509 ]; then',
        '  for argument in "$@"; do',
        '    case "${argument}" in */nats/.nats-cert.pem.*) exit 73 ;; esac',
        '  done',
        'fi',
        'exec /usr/bin/openssl "$@"',
        '',
      ].join('\n'),
      { mode: 0o700 },
    );
    chmodSync(fakeOpenSsl, 0o700);

    try {
      const generated = runGenerator(certs, { PATH: `${fakeBin}:/usr/bin:/bin` });
      expect(generated.status).toBe(73);
      const natsDirectory = join(certs, 'nats');
      for (const name of ['nats-key.pem', 'nats-cert.pem', 'ca-cert.pem']) {
        expect(existsSync(join(natsDirectory, name))).toBe(false);
      }
      expect(readdirSync(natsDirectory).filter((name) => name.startsWith('.nats'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects unsafe certificate roots and a production path override', () => {
    const root = mkdtempSync(join(tmpdir(), 'aqua-cert-root-policy-'));
    const unsafe = join(root, 'unsafe');
    const targetParent = join(root, 'target-parent');
    const target = join(targetParent, 'certs');
    const linkedParent = join(root, 'linked-parent');
    const linked = join(linkedParent, 'certs');
    const unsafeAncestor = join(root, 'unsafe-ancestor');
    const unsafeAncestorCerts = join(unsafeAncestor, 'certs');
    const nestedRoot = join(root, 'nested-root');
    const externalNats = join(root, 'external-nats');
    const override = join(root, 'override');
    mkdirSync(unsafe, { mode: 0o775 });
    chmodSync(unsafe, 0o775);
    mkdirSync(targetParent, { mode: 0o700 });
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(targetParent, linkedParent);
    mkdirSync(unsafeAncestor, { mode: 0o775 });
    chmodSync(unsafeAncestor, 0o775);
    mkdirSync(unsafeAncestorCerts, { mode: 0o700 });
    mkdirSync(nestedRoot, { mode: 0o700 });
    mkdirSync(externalNats, { mode: 0o700 });
    symlinkSync(externalNats, join(nestedRoot, 'nats'));

    try {
      expectFailure(runGenerator(unsafe), 'neither canonical 0700 nor safe legacy 0755');
      expect(mode(unsafe)).toBe(0o775);
      expectFailure(runGenerator(linked), 'symlink or non-directory ancestor rejected');
      expect(lstatSync(target).isDirectory()).toBe(true);
      expectFailure(runGenerator(unsafeAncestorCerts), 'ancestor has unsafe writable mode 775');
      expect(mode(unsafeAncestor)).toBe(0o775);
      expectFailure(runGenerator(nestedRoot), 'symlink or non-directory ancestor rejected');
      expect(lstatSync(join(nestedRoot, 'nats')).isSymbolicLink()).toBe(true);
      expectFailure(
        runGenerator(target, { CERTS_DIR: override }),
        'cannot override DEPLOY_CERTS_DIR',
      );
      expect(existsSync(override)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('mounts only the exact NATS identity authorized for each consumer', () => {
    const document = compose();
    const services = document.services;
    if (services === undefined) throw new Error('droplet Compose services are missing');

    for (const [serviceName, identity] of Object.entries(EXPECTED_NATS_IDENTITIES)) {
      const service = services[serviceName];
      if (service === undefined)
        throw new Error(`droplet Compose service is missing: ${serviceName}`);
      const expectedCertificate = `/etc/ssl/nats-clients/${identity}-cert.pem`;
      const expectedKey = `/etc/ssl/nats-clients/${identity}-key.pem`;
      expect({
        serviceName,
        ca: service.environment?.NATS_TLS_CA,
        certificate: service.environment?.NATS_TLS_CERT,
        key: service.environment?.NATS_TLS_KEY,
      }).toEqual({
        serviceName,
        ca: '/etc/ssl/nats-ca.pem',
        certificate: expectedCertificate,
        key: expectedKey,
      });
      const identityVolumes = (service.volumes ?? []).filter((volume) =>
        volume.startsWith(`${CERTS_PREFIX}/nats/`),
      );
      expect({ serviceName, identityVolumes }).toEqual({
        serviceName,
        identityVolumes: [
          `${CERTS_PREFIX}/nats/ca-cert.pem:/etc/ssl/nats-ca.pem:ro`,
          `${CERTS_PREFIX}/nats/clients/${identity}-cert.pem:${expectedCertificate}:ro`,
          `${CERTS_PREFIX}/nats/clients/${identity}-key.pem:${expectedKey}:ro`,
        ],
      });
    }

    const nats = services.nats;
    if (nats === undefined) throw new Error('droplet NATS service is missing');
    expect(
      (nats.volumes ?? []).filter((volume) => volume.startsWith(`${CERTS_PREFIX}/nats/`)),
    ).toEqual([
      `${CERTS_PREFIX}/nats/nats-cert.pem:/etc/nats/certs/nats-cert.pem:ro`,
      `${CERTS_PREFIX}/nats/nats-key.pem:/etc/nats/certs/nats-key.pem:ro`,
      `${CERTS_PREFIX}/nats/ca-cert.pem:/etc/nats/certs/ca-cert.pem:ro`,
    ]);

    const composeSource = readFileSync(COMPOSE_PATH, 'utf8');
    expect(composeSource).not.toContain('/nats/clients:/');
    expect(composeSource).not.toContain('/nats:/etc/nats/certs');
    expect(composeSource).not.toContain('/nats/client-cert.pem:');
    expect(composeSource).not.toContain('/nats/client-key.pem:');
  });

  it('makes ownership, link count, type, mode, and content mandatory before every skip', () => {
    const generator = readFileSync(GENERATOR_PATH, 'utf8');
    expect(generator).toContain('os.O_NOFOLLOW');
    expect(generator).toContain('dir_fd=current_fd');
    expect(generator).toContain('validate_open_directory(current_fd, "/", False)');
    expect(generator).toContain('ancestor has unsafe writable mode');
    expect(generator).toContain("actual_uid=$(stat -c '%u'");
    expect(generator).toContain("actual_links=$(stat -c '%h'");
    expect(generator).toContain('[ -L "${path}" ] || [ ! -f "${path}" ]');
    expect(generator).toContain('[ ! -s "${path}" ]');
    expect(generator).toContain("actual_mode=$(stat -c '%a'");
    expect(generator).toContain('validate_existing_server_set "${name}" "${cn}"');
    expect(generator).toContain('validate_existing_client_set');
    expect(generator).toContain('validate_certificate_key_pair');
    expect(generator).toContain('validate_certificate_authority');
    expect(generator).toContain('validate_canonical_ca_copy');
    expect(generator).toContain('-purpose "${purpose}"');
    expect(generator).toContain("'certificate authority private key'");
    expect(generator).toContain('create_stage_file');
    expect(generator).toContain('mv -fT -- "${key_stage}"');
    const serverGenerator = generator.slice(
      generator.indexOf('generate_server_cert()'),
      generator.indexOf('generate_per_service_client_cert()'),
    );
    expect(serverGenerator.indexOf('mv -fT -- "${cert_stage}"')).toBeLessThan(
      serverGenerator.indexOf('mv -fT -- "${key_stage}"'),
    );
    expect(serverGenerator.indexOf('mv -fT -- "${ca_stage}"')).toBeLessThan(
      serverGenerator.indexOf('mv -fT -- "${key_stage}"'),
    );
    expect(generator).not.toContain('-CAcreateserial');
    expect(generator).toContain('-set_serial "0x${cert_serial}"');
    expect(generator).toContain('publish_postgres_alias postgres-cert.pem');
    expect(generator).not.toContain('ln -sf ');
  });
});
