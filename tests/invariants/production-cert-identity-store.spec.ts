import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import yaml from 'js-yaml';

import { removeExistingFixtureTree, removeFixtureTree } from '../../tools/gates/fixture-tree';
import { NATS_SERVICES_YAML } from '../../tools/gates/nats-services';
jest.setTimeout(180_000);

const REPO_ROOT = resolve(__dirname, '..', '..');
const GENERATOR_PATH = join(REPO_ROOT, 'infrastructure/docker/scripts/generate-internal-certs.sh');
const COMPOSE_PATH = join(REPO_ROOT, 'docker-compose.droplet.yml');
// The droplet compose reads TLS material through the relative `./certs` path.
// `scripts/deploy/deploy-paths.sh` symlinks that name in the deploy checkout
// onto the persistent DEPLOY_CERTS_DIR, so the compose file itself carries the
// relative form and the deploy owns the indirection.
const CERTS_PREFIX = './certs';

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
  // admin-api-service carries its own CN here. The source branch mapped it
  // onto gateway_service, which predates `admin_api_service` becoming a
  // first-class entry in infrastructure/nats/services.yaml; reusing the
  // gateway's identity would give the admin API the gateway's subject ACLs.
  'admin-api-service': 'admin_api_service',
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
  options: readonly string[] = [],
): SpawnSyncReturns<string> {
  return spawnSync('/bin/bash', [GENERATOR_PATH, ...options], {
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

/**
 * A scratch tree laid out like the repository, as far as the generator reads
 * it: its own directory and services.yaml, which it finds through its own
 * location. Returns the scripts directory.
 */
function layoutScratchRepository(workDirectory: string): string {
  const scripts = join(workDirectory, 'infrastructure/docker/scripts');
  const nats = join(workDirectory, 'infrastructure/nats');
  mkdirSync(scripts, { recursive: true, mode: 0o700 });
  mkdirSync(nats, { recursive: true, mode: 0o700 });
  copyFileSync(join(REPO_ROOT, NATS_SERVICES_YAML), join(nats, basename(NATS_SERVICES_YAML)));
  return scripts;
}

/**
 * Runs a copy of the generator whose source TRANSFORM rewrote, from a scratch
 * tree laid out like the repository (the copy reads services.yaml through its
 * own location), so a spec can change one spelling and see what every reader
 * of it does.
 */
function runGeneratorVariant(
  workDirectory: string,
  certsDirectory: string,
  transform: (source: string) => string,
): SpawnSyncReturns<string> {
  const variant = join(layoutScratchRepository(workDirectory), 'generate-internal-certs.sh');
  writeFileSync(variant, transform(readFileSync(GENERATOR_PATH, 'utf8')), { mode: 0o700 });
  return spawnSync('/bin/bash', [variant], {
    cwd: workDirectory,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LC_ALL: 'C',
      DEPLOY_CERTS_DIR: certsDirectory,
    },
  });
}

/**
 * The generator up to its first issuing step: every function, the managed
 * server table and the store's directory preparation, so a harness can call
 * one function against a real store.
 */
function generatorDefinitions(): string {
  const generator = readFileSync(GENERATOR_PATH, 'utf8');
  const generationStart = generator.indexOf(
    '\necho "=== Generating Internal TLS Certificates ==="',
  );
  if (generationStart < 0) throw new Error('certificate generator validation boundary is missing');
  return generator.slice(0, generationStart);
}

/**
 * Runs the generator's definitions followed by HARNESS_LINES as a script FILE
 * in a scratch repository tree, the way production runs the generator. Its
 * first lines derive SCRIPT_DIR and REPO_ROOT from BASH_SOURCE, which a
 * `bash -c` string does not have: bash 5.3 (the CI runner image's) refuses the
 * resulting `cd ""`, and the harness never reached the function under test.
 */
function runGeneratorHarness(
  harnessLines: readonly string[],
  environment: Readonly<Record<string, string>>,
): SpawnSyncReturns<string> {
  const workDirectory = mkdtempSync(join(tmpdir(), 'aqua-cert-harness-'));
  try {
    const harness = join(layoutScratchRepository(workDirectory), 'generator-harness.sh');
    writeFileSync(harness, [generatorDefinitions(), ...harnessLines].join('\n'), { mode: 0o700 });
    return spawnSync('/bin/bash', [harness], {
      cwd: workDirectory,
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', ...environment },
    });
  } finally {
    removeFixtureTree(workDirectory);
  }
}

function runAssetValidator(
  certsDirectory: string,
  assetPath: string,
  expectedMode: '0600' | '0644',
): SpawnSyncReturns<string> {
  return runGeneratorHarness(
    [`validate_existing_certificate_asset "\${ASSET_PATH}" ${expectedMode} 'fixture asset'`],
    { DEPLOY_CERTS_DIR: certsDirectory, ASSET_PATH: assetPath },
  );
}

function runClientSetValidator(
  certsDirectory: string,
  keyPath: string,
  certificatePath: string,
  expectedIdentity: string,
): SpawnSyncReturns<string> {
  return runGeneratorHarness(
    [
      'validate_existing_client_set "${KEY_PATH}" "${CERTIFICATE_PATH}" "CN=${EXPECTED_IDENTITY}" "fixture client"',
    ],
    {
      DEPLOY_CERTS_DIR: certsDirectory,
      KEY_PATH: keyPath,
      CERTIFICATE_PATH: certificatePath,
      EXPECTED_IDENTITY: expectedIdentity,
    },
  );
}

function runCanonicalCaCopyValidator(
  certsDirectory: string,
  caPath: string,
): SpawnSyncReturns<string> {
  return runGeneratorHarness(['validate_canonical_ca_copy "${CA_PATH}" "fixture CA copy"'], {
    DEPLOY_CERTS_DIR: certsDirectory,
    CA_PATH: caPath,
  });
}

/**
 * One generate_server_cert call with ARGUMENT under --renew-leaves, made
 * outside the issuance loop. The store also gets a prepared directory for a
 * set the table does not hold (minio), so the call meets no missing directory.
 */
function runServerSetIssuer(certsDirectory: string, argument: string): SpawnSyncReturns<string> {
  return runGeneratorHarness(
    [
      'prepare_certificate_directories "${CERTS_DIR}/minio"',
      'RENEW_LEAVES=true',
      'generate_server_cert "${SERVER_SET_ARGUMENT}"',
    ],
    { DEPLOY_CERTS_DIR: certsDirectory, SERVER_SET_ARGUMENT: argument },
  );
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
  readonly caKey: string;
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
  chmodSync(caKey, 0o600);
  chmodSync(caCertificate, 0o644);
  chmodSync(clientKey, 0o644);
  chmodSync(clientCertificate, 0o644);
  return { caKey, caCertificate, clientCertificate, clientKey };
}

/**
 * Re-issues one client leaf under the store's own CA with a short lifetime, as
 * a leaf looks after a renewal that stopped part way through.
 */
function reissueClientLeafUnderStoreCa(
  certs: string,
  workDirectory: string,
  identity: string,
  days: number,
): void {
  const request = join(workDirectory, `${identity}.csr`);
  const issued = join(workDirectory, `${identity}-cert.pem`);
  const certificate = join(certs, `nats/clients/${identity}-cert.pem`);
  runOpenSsl([
    'req',
    '-new',
    '-key',
    join(certs, `nats/clients/${identity}-key.pem`),
    '-out',
    request,
    '-subj',
    `/CN=${identity}`,
  ]);
  runOpenSsl([
    'x509',
    '-req',
    '-days',
    String(days),
    '-in',
    request,
    '-CA',
    join(certs, 'ca/ca-cert.pem'),
    '-CAkey',
    join(certs, 'ca/ca-key.pem'),
    '-set_serial',
    '0x0fedcba987654321',
    '-out',
    issued,
  ]);
  writeFileSync(certificate, readFileSync(issued));
  chmodSync(certificate, 0o644);
}

/** The UTC calendar date (YYYY-MM-DD) on which a certificate expires. */
function notAfterDate(path: string): string {
  const result = spawnSync(
    '/usr/bin/openssl',
    ['x509', '-in', path, '-noout', '-enddate', '-dateopt', 'iso_8601'],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } },
  );
  const date = /^notAfter=(\d{4}-\d{2}-\d{2}) /.exec(result.stdout);
  if (result.status !== 0 || date === null) {
    throw new Error(`could not read the expiry of ${path}: ${result.stderr}`);
  }
  return String(date[1]);
}

/** The UTC calendar date DAYS whole days before DATE (both YYYY-MM-DD). */
function daysBefore(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Re-signs the store's CA with its own key and subject to a shorter lifetime,
 * and writes the result to the CA and every CA copy: the same root, so every
 * leaf still chains to it, but nearer its end.
 */
function resignStoreCa(certs: string, workDirectory: string, days: number): void {
  const resigned = join(workDirectory, `ca-${days}-days.pem`);
  runOpenSsl([
    'req',
    '-new',
    '-x509',
    '-days',
    String(days),
    '-key',
    join(certs, 'ca/ca-key.pem'),
    '-out',
    resigned,
    '-subj',
    '/CN=Aquaculture Internal CA',
  ]);
  for (const copy of ['ca/ca-cert.pem', ...CA_COPIES]) {
    place(join(certs, copy), readFileSync(resigned), 0o644);
  }
}

/** Writes bytes to a store file with an exact mode, recreating it when it is gone. */
function place(path: string, bytes: Buffer, fileMode: number): void {
  writeFileSync(path, bytes);
  chmodSync(path, fileMode);
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

function verifiesAgainst(caPath: string, certificatePath: string, purpose: string): boolean {
  return (
    spawnSync(
      '/usr/bin/openssl',
      [
        'verify',
        '-CAfile',
        caPath,
        '-no-CApath',
        '-no-CAstore',
        '-purpose',
        purpose,
        certificatePath,
      ],
      { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } },
    ).status === 0
  );
}

// The server leaves, CA copies and client leaves that consumers open at start.
const SERVER_LEAVES = ['nats/nats-cert.pem', 'redis/redis-cert.pem', 'postgres/postgres-cert.pem'];
const CA_COPIES = ['nats/ca-cert.pem', 'redis/ca-cert.pem', 'postgres/ca-cert.pem'];
const CLIENT_LEAF = 'nats/clients/auth_service-cert.pem';
const EXPIRING_IDENTITY = 'dlq_replayer';
const EXPIRING_CLIENT_LEAF = `nats/clients/${EXPIRING_IDENTITY}-cert.pem`;

/** SHA-256 of each file, so a changed identity reads as one changed line. */
function snapshot(certs: string, paths: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    paths.map((path) => [
      path,
      createHash('sha256')
        .update(readFileSync(join(certs, path)))
        .digest('hex'),
    ]),
  );
}

interface DeployPathLine {
  readonly file: string;
  readonly line: string;
}

/**
 * Every executable line of the deploy paths (scripts/ and .github/): comment
 * lines and Markdown prose are left out, so only what a deploy runs is read.
 */
function deployPathLines(): readonly DeployPathLine[] {
  const lines: DeployPathLine[] = [];
  for (const tree of ['scripts', '.github']) {
    for (const entry of readdirSync(join(REPO_ROOT, tree), { recursive: true })) {
      const file = `${tree}/${String(entry)}`;
      const path = join(REPO_ROOT, file);
      if (file.endsWith('.md') || !lstatSync(path).isFile()) continue;
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!/^\s*(?:#|\/\/|\/?\*)/.test(line)) lines.push({ file, line });
      }
    }
  }
  return lines;
}

/** Each deploy-path call of the generator, with the argv it passes. */
function deployGeneratorInvocations(): readonly { readonly file: string; readonly argv: string }[] {
  return deployPathLines().flatMap(({ file, line }) => {
    const call = /\bbash\s+(?:\S*\/)?generate-internal-certs\.sh\b(.*)$/.exec(line);
    return call === null ? [] : [{ file, argv: (call[1] ?? '').trim() }];
  });
}

/**
 * The generator options droplet-up.sh passes, read from the script itself so
 * the renewal test drives the deploy's own call.
 */
function dropletGeneratorOptions(): readonly string[] {
  const calls = deployGeneratorInvocations().filter(
    ({ file }) => file === 'scripts/deploy/droplet-up.sh',
  );
  const [call] = calls;
  if (calls.length !== 1 || call === undefined) {
    throw new Error(`droplet-up.sh must call the generator exactly once; found ${calls.length}`);
  }
  return call.argv.split(/\s+/).filter((option) => option.length > 0);
}

describe('production certificate identity store', () => {
  it('renews every leaf under the kept CA once any one nears expiry (INFRA-CRITICAL-233)', () => {
    const root = mkdtempSync(join(tmpdir(), 'aqua-cert-leaf-renewal-'));
    const certs = join(root, 'certs');
    const running = join(root, 'running');
    const authorityPaths = ['ca/ca-key.pem', 'ca/ca-cert.pem', ...CA_COPIES];
    const leafPaths = [...SERVER_LEAVES, CLIENT_LEAF, EXPIRING_CLIENT_LEAF];
    const options = dropletGeneratorOptions();
    const deploy = (): SpawnSyncReturns<string> => runGenerator(certs, {}, options);
    const renew = (): SpawnSyncReturns<string> => runGenerator(certs, {}, ['--renew-leaves']);
    mkdirSync(certs, { mode: 0o700 });
    mkdirSync(running, { mode: 0o700 });

    try {
      const bootstrap = runGenerator(certs);
      expect({ status: bootstrap.status, stderr: bootstrap.stderr }).toEqual({
        status: 0,
        stderr: '',
      });
      // An application rollout leaves the broker running on what it opened at
      // start: its CA copy and its server leaf (single-file bind mounts).
      copyFileSync(join(certs, 'nats/ca-cert.pem'), join(running, 'broker-ca.pem'));
      copyFileSync(join(certs, 'nats/nats-cert.pem'), join(running, 'broker-server.pem'));
      const authority = snapshot(certs, authorityPaths);

      // One client leaf has 60 days left, outside the renewal window: the
      // deploy's call changes nothing, and its log still names that leaf as
      // the earliest expiry and states when the CA stops accepting new leaves,
      // so the countdown is in every deploy log, not only in the one that acts.
      reissueClientLeafUnderStoreCa(certs, root, EXPIRING_IDENTITY, 60);
      const fresh = snapshot(certs, leafPaths);
      const quiet = deploy();
      expect({ status: quiet.status, renewing: quiet.stdout.includes('[renew]') }).toEqual({
        status: 0,
        renewing: false,
      });
      expect(snapshot(certs, leafPaths)).toEqual(fresh);
      // Whole UTC days: the CA's last issuing date is its expiry date less 365.
      const caExpiry = notAfterDate(join(certs, 'ca/ca-cert.pem'));
      const lastIssuance = daysBefore(caExpiry, 365);
      const leafExpiry = notAfterDate(join(certs, EXPIRING_CLIENT_LEAF));
      expect(quiet.stdout).toMatch(
        new RegExp(
          `\\[expiry\\] earliest leaf: ${EXPIRING_IDENTITY} client certificate, notAfter ${leafExpiry} \\((59|60) days left; every leaf renews once one is inside 30 days\\)`,
        ),
      );
      expect(quiet.stdout).toMatch(
        new RegExp(
          `\\[expiry\\] CA: notAfter ${caExpiry} \\((3649|3650) days left\\); last date a new leaf can be issued: ${lastIssuance}; replace it with --rotate-ca before then`,
        ),
      );

      // One client leaf enters the renewal window while the redis leaf is
      // fresh, as after a renewal that stopped part way through. The deploy's
      // own call renews every leaf under the CA it keeps.
      reissueClientLeafUnderStoreCa(certs, root, EXPIRING_IDENTITY, 10);
      const leaves = snapshot(certs, leafPaths);
      const renewed = deploy();
      expect({ options, status: renewed.status, stderr: renewed.stderr }).toEqual({
        options,
        status: 0,
        stderr: '',
      });
      expect(renewed.stdout).toContain(
        `[renew] ${EXPIRING_IDENTITY} client certificate expires within 30 days`,
      );
      expect(snapshot(certs, authorityPaths)).toEqual(authority);
      const renewedLeaves = snapshot(certs, leafPaths);
      expect(leafPaths.filter((path) => renewedLeaves[path] === leaves[path])).toEqual([]);
      const settled = deploy();
      expect({ status: settled.status, renewing: settled.stdout.includes('[renew]') }).toEqual({
        status: 0,
        renewing: false,
      });
      expect(snapshot(certs, leafPaths)).toEqual(renewedLeaves);
      // Both directions of the handshake between a restarted service and the
      // broker that kept running: the broker's old leaf passes the restarted
      // client's CA copy, and the client's new leaf passes the broker's CA.
      expect({
        restartedClientTrustsRunningBroker: verifiesAgainst(
          join(certs, 'nats/ca-cert.pem'),
          join(running, 'broker-server.pem'),
          'sslserver',
        ),
        runningBrokerTrustsRestartedClient: verifiesAgainst(
          join(running, 'broker-ca.pem'),
          join(certs, CLIENT_LEAF),
          'sslclient',
        ),
        runningBrokerCaTrustsRenewedServerLeaf: verifiesAgainst(
          join(running, 'broker-ca.pem'),
          join(certs, 'nats/nats-cert.pem'),
          'sslserver',
        ),
      }).toEqual({
        restartedClientTrustsRunningBroker: true,
        runningBrokerTrustsRestartedClient: true,
        runningBrokerCaTrustsRenewedServerLeaf: true,
      });

      // An operator's explicit renewal keeps the CA in the same way.
      const explicit = renew();
      expect({ status: explicit.status, stderr: explicit.stderr }).toEqual({
        status: 0,
        stderr: '',
      });
      expect(snapshot(certs, authorityPaths)).toEqual(authority);
      const explicitLeaves = snapshot(certs, leafPaths);
      expect(leafPaths.filter((path) => explicitLeaves[path] === renewedLeaves[path])).toEqual([]);
      expect(
        verifiesAgainst(join(running, 'broker-ca.pem'), join(certs, CLIENT_LEAF), 'sslclient'),
      ).toBe(true);

      // Renewal refuses a trust root it cannot validate and changes nothing.
      const caCertificate = join(certs, 'ca/ca-cert.pem');
      const caKey = join(certs, 'ca/ca-key.pem');
      const caCertificateBytes = readFileSync(caCertificate);
      const caKeyBytes = readFileSync(caKey);
      const alternate = generateAlternateClientIdentity(root, 'auth_service');
      for (const [path, bytes, fragment] of [
        [caCertificate, Buffer.from('invalid X.509\n'), 'not a parseable X.509 certificate'],
        [caKey, Buffer.from('invalid private key\n'), 'not a parseable private key'],
        [
          caCertificate,
          readFileSync(alternate.caCertificate),
          'certificate and private key do not match',
        ],
      ] as const) {
        writeFileSync(path, bytes);
        expectFailure(renew(), fragment);
        expect(snapshot(certs, leafPaths)).toEqual(explicitLeaves);
        writeFileSync(caCertificate, caCertificateBytes);
        writeFileSync(caKey, caKeyBytes);
      }

      // The retired ambiguous spelling and unknown options are refused.
      for (const refused of [['--force'], ['--renew'], ['--renew-leaves', '--rotate-ca']]) {
        const result = runGenerator(certs, {}, refused);
        expect({ refused, status: result.status }).toEqual({ refused, status: 2 });
        expect(result.stderr).toContain('usage:');
        expect(snapshot(certs, [...authorityPaths, ...leafPaths])).toEqual({
          ...authority,
          ...explicitLeaves,
        });
      }
    } finally {
      removeFixtureTree(root);
    }

    // Renewal never mints a trust root: an empty store has nothing to renew under.
    const empty = mkdtempSync(join(tmpdir(), 'aqua-cert-leaf-renewal-empty-'));
    try {
      const emptyCerts = join(empty, 'certs');
      mkdirSync(emptyCerts, { mode: 0o700 });
      expectFailure(
        runGenerator(emptyCerts, {}, ['--renew-leaves']),
        'leaf renewal requires an existing validated certificate authority',
      );
      expect(existsSync(join(emptyCerts, 'ca/ca-key.pem'))).toBe(false);
      expect(existsSync(join(emptyCerts, 'nats/nats-cert.pem'))).toBe(false);
    } finally {
      removeFixtureTree(empty);
    }
  });

  it('issues under the kept CA only when the store was issued under it, and never publishes a CA over a store that lost its own', () => {
    const root = mkdtempSync(join(tmpdir(), 'aqua-cert-ca-continuity-'));
    const certs = join(root, 'certs');
    const authorityFiles = ['ca/ca-key.pem', 'ca/ca-cert.pem'];
    const issuedPaths = [
      ...CA_COPIES,
      ...SERVER_LEAVES,
      'redis/redis-key.pem',
      CLIENT_LEAF,
      CLIENT_LEAF.replace('-cert.pem', '-key.pem'),
    ];
    mkdirSync(certs, { mode: 0o700 });
    try {
      expect(runGenerator(certs).status).toBe(0);
      const issued = snapshot(certs, issuedPaths);
      const authority = snapshot(certs, authorityFiles);
      const original = new Map(
        [...authorityFiles, ...issuedPaths].map((path) => [path, readFileSync(join(certs, path))]),
      );
      const restore = (): void => {
        for (const [path, bytes] of original) {
          place(join(certs, path), bytes, path === 'ca/ca-key.pem' ? 0o600 : 0o644);
        }
      };
      const alternate = generateAlternateClientIdentity(root, 'auth_service');
      const alternateServerDirectory = join(root, 'alternate-server');
      mkdirSync(alternateServerDirectory, { mode: 0o700 });
      const alternateServer = generateAlternateClientIdentity(alternateServerDirectory, 'redis');
      // Each store holds identities issued under a root other than the one in
      // ca/ (or under a ca/ that is gone). Renewing or issuing there would hand
      // restarted services a root the running consumers do not hold.
      for (const { name, diverge, fragments } of [
        {
          // A valid CA pair in ca/ that issued nothing in the store: an
          // interrupted --rotate-ca, or a partial restore of ca/.
          name: 'replacement CA in ca/',
          diverge: (): void => {
            place(join(certs, 'ca/ca-key.pem'), readFileSync(alternate.caKey), 0o600);
            place(join(certs, 'ca/ca-cert.pem'), readFileSync(alternate.caCertificate), 0o644);
          },
          fragments: [
            'nats server CA certificate does not exactly match the canonical CA certificate',
            'nats server CA certificate does not exactly match the canonical CA certificate',
          ],
        },
        {
          // The last CA copy differs; nothing may be renewed before it is read.
          name: 'divergent PostgreSQL CA copy',
          diverge: (): void => {
            place(
              join(certs, 'postgres/ca-cert.pem'),
              readFileSync(alternate.caCertificate),
              0o644,
            );
          },
          fragments: [
            'postgres server CA certificate does not exactly match the canonical CA certificate',
            'postgres server CA certificate does not exactly match the canonical CA certificate',
          ],
        },
        {
          // A server leaf is read from the same path it is issued to: the
          // registration and issuance loops share one table and one path helper.
          name: 'server leaf from another CA',
          diverge: (): void => {
            place(
              join(certs, 'redis/redis-cert.pem'),
              readFileSync(alternateServer.clientCertificate),
              0o644,
            );
            place(
              join(certs, 'redis/redis-key.pem'),
              readFileSync(alternateServer.clientKey),
              0o644,
            );
          },
          fragments: [
            'redis server certificate was not issued under the kept certificate authority',
            'redis server certificate was not issued under the kept certificate authority',
          ],
        },
        {
          name: 'client leaf from another CA',
          diverge: (): void => {
            place(join(certs, CLIENT_LEAF), readFileSync(alternate.clientCertificate), 0o644);
            place(
              join(certs, CLIENT_LEAF.replace('-cert.pem', '-key.pem')),
              readFileSync(alternate.clientKey),
              0o644,
            );
          },
          fragments: [
            'auth_service client certificate was not issued under the kept certificate authority',
            'auth_service client certificate was not issued under the kept certificate authority',
          ],
        },
        {
          // ca/ is lost while its leaves and CA copies remain.
          name: 'lost CA',
          diverge: (): void => {
            for (const path of authorityFiles) unlinkSync(join(certs, path));
          },
          fragments: [
            'the certificate authority is missing but identities issued under one remain',
            'leaf renewal requires an existing validated certificate authority',
          ],
        },
      ]) {
        const optionSets: readonly (readonly string[])[] = [[], ['--renew-leaves']];
        optionSets.forEach((options, index) => {
          diverge();
          const presentAuthority = authorityFiles.filter((path) => existsSync(join(certs, path)));
          const before = snapshot(certs, [...presentAuthority, ...issuedPaths]);
          const result = runGenerator(certs, {}, options);
          expect({ name, options, failed: result.status !== 0 }).toEqual({
            name,
            options,
            failed: true,
          });
          expect(result.stderr).toContain(fragments[index]);
          expect({
            name,
            options,
            authority: authorityFiles.filter((path) => existsSync(join(certs, path))),
            store: snapshot(certs, [...presentAuthority, ...issuedPaths]),
          }).toEqual({ name, options, authority: presentAuthority, store: before });
          restore();
        });
      }
      expect(runGenerator(certs).status).toBe(0);
      expect(snapshot(certs, [...authorityFiles, ...issuedPaths])).toEqual({
        ...authority,
        ...issued,
      });
    } finally {
      removeFixtureTree(root);
    }
  });

  it('issues a server identity only for a set the managed table holds', () => {
    const root = mkdtempSync(join(tmpdir(), 'aqua-cert-server-table-'));
    const certs = join(root, 'certs');
    const serverSetFiles = [
      ...SERVER_LEAVES,
      ...CA_COPIES,
      'nats/nats-key.pem',
      'redis/redis-key.pem',
      'postgres/postgres-key.pem',
    ];
    mkdirSync(certs, { mode: 0o700 });
    try {
      expect(runGenerator(certs).status).toBe(0);
      const issued = snapshot(certs, serverSetFiles);
      // The continuity and expiry checks read the table's rows, so a server
      // identity issued from anything else would be neither: a row outside the
      // table, a table name with a widened subjectAltName, a bare unlisted name.
      for (const argument of [
        'minio|minio|DNS:minio|0644',
        'nats|nats|DNS:nats,DNS:evil.example|0644',
        'minio',
      ]) {
        const result = runServerSetIssuer(certs, argument);
        expectFailure(result, `not a managed server set: ${argument}`);
        expect({ argument, minio: readdirSync(join(certs, 'minio')) }).toEqual({
          argument,
          minio: [],
        });
        expect({ argument, store: snapshot(certs, serverSetFiles) }).toEqual({
          argument,
          store: issued,
        });
      }
      // A table name is issued under the kept CA, from the table's own row.
      const renewed = runServerSetIssuer(certs, 'redis');
      expect(renewed.status).toBe(0);
      expect(renewed.stdout).toContain('[done] redis (CN=redis)');
      expect(snapshot(certs, ['redis/redis-cert.pem'])['redis/redis-cert.pem']).not.toBe(
        issued['redis/redis-cert.pem'],
      );
      expect(readFileSync(join(certs, 'redis/ca-cert.pem'))).toEqual(
        readFileSync(join(certs, 'ca/ca-cert.pem')),
      );
      expect(
        verifiesAgainst(
          join(certs, 'ca/ca-cert.pem'),
          join(certs, 'redis/redis-cert.pem'),
          'sslserver',
        ),
      ).toBe(true);
    } finally {
      removeFixtureTree(root);
    }
  });

  it('refuses to issue a leaf that would outlive the CA that signs it', () => {
    const root = mkdtempSync(join(tmpdir(), 'aqua-cert-ca-lifetime-'));
    const certs = join(root, 'certs');
    const caKey = join(certs, 'ca/ca-key.pem');
    const caCertificate = join(certs, 'ca/ca-cert.pem');
    mkdirSync(certs, { mode: 0o700 });
    mkdirSync(join(certs, 'ca'), { mode: 0o700 });
    try {
      runOpenSsl(['genrsa', '-out', caKey, '2048']);
      runOpenSsl([
        'req',
        '-new',
        '-x509',
        '-days',
        '200',
        '-key',
        caKey,
        '-out',
        caCertificate,
        '-subj',
        '/CN=Aquaculture Internal CA',
      ]);
      chmodSync(caKey, 0o600);
      chmodSync(caCertificate, 0o644);
      const optionSets: readonly (readonly string[])[] = [[], ['--renew-leaves']];
      for (const options of optionSets) {
        expectFailure(
          runGenerator(certs, {}, options),
          'the certificate authority expires before a new 365-day leaf would; replace it with --rotate-ca',
        );
        expect({ options, issued: existsSync(join(certs, 'nats/nats-cert.pem')) }).toEqual({
          options,
          issued: false,
        });
      }
    } finally {
      removeFixtureTree(root);
    }
  });

  it('logs when the earliest leaf stops verifying and whether the CA can still sign its renewal', () => {
    const root = mkdtempSync(join(tmpdir(), 'aqua-cert-expiry-report-'));
    const certs = join(root, 'certs');
    const storePaths = [
      'ca/ca-key.pem',
      'ca/ca-cert.pem',
      ...CA_COPIES,
      ...SERVER_LEAVES,
      CLIENT_LEAF,
      EXPIRING_CLIENT_LEAF,
    ];
    const options = dropletGeneratorOptions();
    const deploy = (): SpawnSyncReturns<string> => runGenerator(certs, {}, options);
    mkdirSync(certs, { mode: 0o700 });
    try {
      expect(runGenerator(certs).status).toBe(0);

      // The CA can sign a 365-day leaf today but not when the earliest leaf
      // falls due: the leaf line must not promise that renewal.
      resignStoreCa(certs, root, 500);
      reissueClientLeafUnderStoreCa(certs, root, EXPIRING_IDENTITY, 300);
      const closingStore = snapshot(certs, storePaths);
      const closing = deploy();
      expect({ status: closing.status, stderr: closing.stderr }).toEqual({ status: 0, stderr: '' });
      expect(snapshot(certs, storePaths)).toEqual(closingStore);
      const closingCaExpiry = notAfterDate(join(certs, 'ca/ca-cert.pem'));
      const closingLeafExpiry = notAfterDate(join(certs, EXPIRING_CLIENT_LEAF));
      expect(closing.stdout).toMatch(
        new RegExp(
          `\\[expiry\\] earliest leaf: ${EXPIRING_IDENTITY} client certificate, notAfter ${closingLeafExpiry} \\((299|300) days left; its renewal, due from ${daysBefore(closingLeafExpiry, 30)}, falls after the CA's last issuing date and will be refused\\)`,
        ),
      );
      expect(closing.stdout).toMatch(
        new RegExp(
          `\\[expiry\\] CA: notAfter ${closingCaExpiry} \\((499|500) days left\\); last date a new leaf can be issued: ${daysBefore(closingCaExpiry, 365)}; replace it with --rotate-ca before then`,
        ),
      );

      // The CA can no longer sign a 365-day leaf, and it expires before the
      // leaves: every leaf stops verifying on the CA's date, and the log says
      // that the next renewal or new identity is refused, as it is.
      resignStoreCa(certs, root, 200);
      reissueClientLeafUnderStoreCa(certs, root, EXPIRING_IDENTITY, 300);
      const overdueStore = snapshot(certs, storePaths);
      const overdue = deploy();
      expect({ status: overdue.status, stderr: overdue.stderr }).toEqual({ status: 0, stderr: '' });
      expect(snapshot(certs, storePaths)).toEqual(overdueStore);
      const overdueCaExpiry = notAfterDate(join(certs, 'ca/ca-cert.pem'));
      const overdueLeafExpiry = notAfterDate(join(certs, EXPIRING_CLIENT_LEAF));
      expect(overdue.stdout).toMatch(
        new RegExp(
          `\\[expiry\\] earliest leaf: ${EXPIRING_IDENTITY} client certificate, notAfter ${overdueLeafExpiry}, but the CA expires first: every leaf stops verifying on ${overdueCaExpiry} \\((199|200) days left; its renewal, due from ${daysBefore(overdueLeafExpiry, 30)}, falls after the CA's last issuing date and will be refused\\)`,
        ),
      );
      expect(overdue.stdout).toMatch(
        new RegExp(
          `\\[expiry\\] CA: notAfter ${overdueCaExpiry} \\((199|200) days left\\); it can sign no 365-day leaf since ${daysBefore(overdueCaExpiry, 365)}, so every renewal and new identity is refused: run --rotate-ca now`,
        ),
      );
      expect(overdue.stdout).not.toContain('before then');
      expectFailure(
        runGenerator(certs, {}, ['--renew-leaves']),
        'the certificate authority expires before a new 365-day leaf would; replace it with --rotate-ca',
      );
      expect(snapshot(certs, storePaths)).toEqual(overdueStore);
    } finally {
      removeFixtureTree(root);
    }
  });

  it('publishes the PostgreSQL aliases from the postgres row of the managed table', () => {
    const root = mkdtempSync(join(tmpdir(), 'aqua-cert-postgres-alias-'));
    const certs = join(root, 'certs');
    const postgres = join(certs, 'postgres');
    // Another file layout in load_server_set, the one place a set's files are
    // spelled: the aliases must follow it, never name the old files.
    const respelling: readonly (readonly [string, string])[] = [
      [
        'SERVER_SET_KEY="${SERVER_SET_DIR}/${name}-key.pem"',
        'SERVER_SET_KEY="${SERVER_SET_DIR}/${name}-server-key.pem"',
      ],
      [
        'SERVER_SET_CERT="${SERVER_SET_DIR}/${name}-cert.pem"',
        'SERVER_SET_CERT="${SERVER_SET_DIR}/${name}-server-cert.pem"',
      ],
      [
        'SERVER_SET_CA="${SERVER_SET_DIR}/ca-cert.pem"',
        'SERVER_SET_CA="${SERVER_SET_DIR}/${name}-ca-cert.pem"',
      ],
    ];
    mkdirSync(certs, { mode: 0o700 });
    try {
      const variant = runGeneratorVariant(join(root, 'variant'), certs, (source) =>
        respelling.reduce((text, [spelled, respelled]) => {
          const pieces = text.split(spelled);
          if (pieces.length !== 2) throw new Error(`the generator must spell ${spelled} once`);
          return pieces.join(respelled);
        }, source),
      );
      expect({ status: variant.status, stderr: variant.stderr }).toEqual({ status: 0, stderr: '' });
      expect({
        'server.crt': readlinkSync(join(postgres, 'server.crt')),
        'server.key': readlinkSync(join(postgres, 'server.key')),
        'root.crt': readlinkSync(join(postgres, 'root.crt')),
      }).toEqual({
        'server.crt': 'postgres-server-cert.pem',
        'server.key': 'postgres-server-key.pem',
        'root.crt': 'postgres-ca-cert.pem',
      });
      expect(readFileSync(join(postgres, 'root.crt'))).toEqual(
        readFileSync(join(certs, 'ca/ca-cert.pem')),
      );
      expect(
        verifiesAgainst(join(postgres, 'root.crt'), join(postgres, 'server.crt'), 'sslserver'),
      ).toBe(true);

      // An alias is never published onto a file that is not there.
      const dangling = spawnSync(
        '/bin/bash',
        [
          '-c',
          [
            generatorDefinitions(),
            'publish_postgres_alias postgres-cert.pem "${CERTS_DIR}/postgres/server.crt"',
          ].join('\n'),
        ],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', DEPLOY_CERTS_DIR: certs },
        },
      );
      expectFailure(dangling, 'PostgreSQL alias target is not a regular non-symlink file');
      expect(readlinkSync(join(postgres, 'server.crt'))).toBe('postgres-server-cert.pem');
      expect(readdirSync(postgres).filter((entry) => entry.startsWith('.postgres-alias.'))).toEqual(
        [],
      );
    } finally {
      removeFixtureTree(root);
    }
  });

  it('leaves the renewal decision to the generator: no deploy path passes it an option', () => {
    const invocations = deployGeneratorInvocations();
    expect(invocations.map(({ file }) => file)).toEqual(
      expect.arrayContaining([
        'scripts/deploy/droplet-up.sh',
        '.github/workflows/deploy-staging.yml',
      ]),
    );
    expect(invocations.filter(({ argv }) => argv !== '')).toEqual([]);
    // --rotate-ca replaces the root under running consumers: an operator
    // ceremony, never a step any deploy path runs.
    expect(deployPathLines().filter(({ line }) => line.includes('--rotate-ca'))).toEqual([]);
  });

  it('replaces the CA only when asked to by name, and re-signs every leaf under it', () => {
    const root = mkdtempSync(join(tmpdir(), 'aqua-cert-ca-rotation-'));
    const certs = join(root, 'certs');
    mkdirSync(certs, { mode: 0o700 });
    try {
      expect(runGenerator(certs).status).toBe(0);
      const previousCa = join(root, 'previous-ca.pem');
      copyFileSync(join(certs, 'ca/ca-cert.pem'), previousCa);
      const authority = snapshot(certs, ['ca/ca-key.pem', 'ca/ca-cert.pem']);

      const rotated = runGenerator(certs, {}, ['--rotate-ca']);
      expect({ status: rotated.status, stderr: rotated.stderr }).toEqual({ status: 0, stderr: '' });
      const rotatedAuthority = snapshot(certs, ['ca/ca-key.pem', 'ca/ca-cert.pem']);
      expect(rotatedAuthority['ca/ca-key.pem']).not.toBe(authority['ca/ca-key.pem']);
      expect(rotatedAuthority['ca/ca-cert.pem']).not.toBe(authority['ca/ca-cert.pem']);
      const caCertificate = join(certs, 'ca/ca-cert.pem');
      expect(snapshot(certs, CA_COPIES)).toEqual(
        Object.fromEntries(CA_COPIES.map((path) => [path, rotatedAuthority['ca/ca-cert.pem']])),
      );
      for (const path of SERVER_LEAVES) {
        expect({
          path,
          verifies: verifiesAgainst(caCertificate, join(certs, path), 'sslserver'),
        }).toEqual({
          path,
          verifies: true,
        });
      }
      // Why rotation is a ceremony and not a deploy step: a consumer still
      // holding the previous CA refuses every leaf the rotation issued.
      expect(verifiesAgainst(previousCa, join(certs, CLIENT_LEAF), 'sslclient')).toBe(false);
    } finally {
      removeFixtureTree(root);
    }
  });

  it('refuses an unparseable identity instead of skipping it as valid (INFRA-MEDIUM-234)', () => {
    const root = mkdtempSync(join(tmpdir(), 'aqua-cert-unparseable-'));
    const certs = join(root, 'certs');
    mkdirSync(certs, { mode: 0o700 });
    try {
      expect(runGenerator(certs).status).toBe(0);
      for (const { path, fragment, skipLine } of [
        {
          path: 'nats/nats-cert.pem',
          fragment: 'nats server certificate is not a parseable X.509 certificate',
          skipLine: '[skip] nats',
        },
        {
          path: CLIENT_LEAF.replace('-cert.pem', '-key.pem'),
          fragment: 'auth_service client private key is not a parseable private key',
          skipLine: '[skip] auth_service client',
        },
        {
          path: 'ca/ca-cert.pem',
          fragment: 'certificate authority certificate is not a parseable X.509 certificate',
          skipLine: '[skip] CA',
        },
        {
          path: 'ca/ca-key.pem',
          fragment: 'certificate authority private key is not a parseable private key',
          skipLine: '[skip] CA',
        },
      ]) {
        const target = join(certs, path);
        const original = readFileSync(target);
        writeFileSync(target, 'garbage\n');
        const result = runGenerator(certs);
        expect({
          path,
          failed: result.status !== 0,
          skipped: result.stdout.includes(skipLine),
        }).toEqual({
          path,
          failed: true,
          skipped: false,
        });
        expect(result.stderr).toContain(fragment);
        writeFileSync(target, original);
      }
      expect(runGenerator(certs).status).toBe(0);
    } finally {
      removeFixtureTree(root);
    }

    // The class, not only these six branches: a bare `return` straight after a
    // negated test returns that test's status, 0, from a failure branch.
    const generator = readFileSync(GENERATOR_PATH, 'utf8');
    expect(generator.match(/^\s*if ! [^\n]*; then\n\s*return\s*$/gm) ?? []).toEqual([]);
  });

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
      // The legacy shared `nats/client-*.pem` identity was deleted from this
      // generator on main (a297b45dd) once every deployment had rotated to
      // per-service certificates. A shared client certificate is one CN that
      // any consumer could present, which is the opposite of what ADR-015 asks
      // the certificate to mean, so its absence is asserted rather than its
      // skip line.
      expect(skipped.stdout).not.toContain('legacy shared');
      expect(existsSync(join(certs, 'nats/client-cert.pem'))).toBe(false);
      expect(existsSync(join(certs, 'nats/client-key.pem'))).toBe(false);

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

      // The symlink probe used the legacy shared `nats/client-cert.pem`, which
      // no longer exists; it runs against a per-service identity instead.
      const serviceCertificate = join(certs, 'nats/clients/gateway_service-cert.pem');
      const serviceCertificateOriginal = `${serviceCertificate}.original`;
      renameSync(serviceCertificate, serviceCertificateOriginal);
      symlinkSync(serviceCertificateOriginal, serviceCertificate);
      expectFailure(
        runAssetValidator(certs, serviceCertificate, '0644'),
        'not a regular non-symlink file',
      );
      unlinkSync(serviceCertificate);
      renameSync(serviceCertificateOriginal, serviceCertificate);

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
      removeExistingFixtureTree(serverAlias);
      const repairedAlias = generate();
      expect({ status: repairedAlias.status, stderr: repairedAlias.stderr }).toEqual({
        status: 0,
        stderr: '',
      });
      expect(readlinkSync(serverAlias)).toBe('postgres-cert.pem');
    } finally {
      removeFixtureTree(root);
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
      removeFixtureTree(root);
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
      removeFixtureTree(root);
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
    expect(generator).toContain('validate_existing_server_set "${name}"');
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
    expect(generator).toContain(
      'publish_postgres_alias "${SERVER_SET_CERT##*/}" "${SERVER_SET_DIR}/server.crt"',
    );
    expect(generator).not.toContain('ln -sf ');
  });
});
