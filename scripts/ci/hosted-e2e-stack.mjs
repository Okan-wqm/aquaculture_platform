#!/usr/bin/env node
/** Isolated hosted E2E runtime derived from the production catalog and Compose contract. */
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
  throw new Error('E2E stack may run only on an isolated GitHub-hosted runner');
}
const [operation] = process.argv.slice(2);
const root = process.cwd();
const sha = process.env.HEAD_SHA;
if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('HEAD_SHA must be an immutable candidate');
if (execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== sha)
  throw new Error('Candidate checkout mismatch');
const project = `aqua-e2e-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
const state = join(process.env.RUNNER_TEMP, project);
const composePath = join(state, 'compose.json');
const envPath = join(state, 'runtime.env');
const catalog = JSON.parse(
  readFileSync('infrastructure/deploy/service-catalog.generated.json', 'utf8'),
).deploy;
const images = [
  ...catalog.backendImageTargets,
  ...catalog.frontendImageTargets,
  ...catalog.infraImageTargets,
];
const services = [
  ...images,
  'redis',
  'redis-auth',
  'nats',
  'minio',
  'nginx',
  'tenant-schema-provisioner',
];
const compose = ['compose', '--project-name', project, '--file', composePath];
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0 || result.error) throw new Error(`${command} failed (${result.status})`);
}
function capture(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  }).trim();
}
function imageTag(service) {
  return `aquaculture-e2e/${service}:${sha}`;
}
function privateFile(path, value) {
  writeFileSync(path, value, { mode: 0o600 });
}

if (operation === 'prepare') {
  if (existsSync(state)) throw new Error('E2E runtime generation already exists');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const source = readFileSync('docker-compose.droplet.yml', 'utf8');
  const values = {};
  for (const match of source.matchAll(/\$\{([A-Z_][A-Z0-9_]*):\?[^}]*\}/g))
    values[match[1]] = randomBytes(32).toString('hex');
  for (const prefix of catalog.serviceDbRolePrefixes)
    values[`${prefix}_SERVICE_DB_PASS`] = randomBytes(32).toString('hex');
  Object.assign(values, {
    TAG: sha,
    DEPLOY_SHA: sha,
    DEPLOY_RELEASE_ID: project,
    POSTGRES_USER: 'aquaculture',
    POSTGRES_DB: 'aquaculture_e2e',
    DEPLOY_CERTS_DIR: join(state, 'certs'),
    SUPER_ADMIN_EMAIL: 'e2e-platform@example.test',
    SUPER_ADMIN_PASSWORD: `E2e-${randomBytes(20).toString('hex')}!`,
    CORS_ORIGINS: 'https://localhost',
    FRONTEND_URL: 'https://localhost',
    WEBAUTHN_RP_ID: 'localhost',
    SERVICE_IDENTITY_SIGNING_KID: 'hosted-e2e',
    SERVICE_IDENTITY_KEYRING: JSON.stringify([
      { kid: 'hosted-e2e', secret: randomBytes(32).toString('hex'), status: 'active' },
    ]),
    WALG_BACKUP_EPOCH: project,
    WALG_SPACES_BUCKET: 'hosted-e2e-unused',
    SPACES_ENDPOINT: 'http://minio:9000',
    SPACES_REGION: 'us-east-1',
    MINIO_USER: 'hosted-e2e',
  });
  privateFile(
    envPath,
    Object.entries(values)
      .map(([key, value]) => `${key}='${value}'`)
      .join('\n') + '\n',
  );
  privateFile(join(state, 'runtime.json'), JSON.stringify(values));
  run('bash', ['infrastructure/docker/scripts/generate-internal-certs.sh'], {
    env: { ...process.env, DEPLOY_CERTS_DIR: values.DEPLOY_CERTS_DIR },
  });
  const jwtDir = join(state, 'certs', 'jwt');
  mkdirSync(jwtDir, { recursive: true, mode: 0o700 });
  run('openssl', ['genrsa', '-out', join(jwtDir, 'private.pem'), '2048']);
  run('openssl', [
    'rsa',
    '-in',
    join(jwtDir, 'private.pem'),
    '-pubout',
    '-out',
    join(jwtDir, 'public.pem'),
  ]);
  chmodSync(join(jwtDir, 'private.pem'), 0o400);
  run('sudo', ['chown', '1001:1001', join(jwtDir, 'private.pem')]);
  const tlsDirectory = join(state, 'edge', 'live', 'localhost');
  mkdirSync(tlsDirectory, { recursive: true, mode: 0o700 });
  run(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout',
      join(tlsDirectory, 'privkey.pem'),
      '-out',
      join(tlsDirectory, 'fullchain.pem'),
    ],
    { stdio: 'ignore' },
  );
  chmodSync(join(tlsDirectory, 'privkey.pem'), 0o600);
  writeFileSync(
    join(state, 'nginx.conf'),
    readFileSync('infrastructure/nginx/droplet.conf', 'utf8').replaceAll(
      'app.suderra.com',
      'localhost',
    ),
  );
  mkdirSync(join(state, 'certbot'), { recursive: true });
  const model = JSON.parse(
    capture('docker', [
      'compose',
      '--env-file',
      envPath,
      '-f',
      'docker-compose.droplet.yml',
      'config',
      '--format',
      'json',
    ]),
  );
  const selected = {};
  for (const service of services) {
    const definition = model.services[service];
    if (!definition) throw new Error(`Catalog service missing in production Compose: ${service}`);
    delete definition.container_name;
    delete definition.profiles;
    definition.restart = 'no';
    if (images.includes(service)) definition.image = imageTag(service);
    if (service === 'tenant-schema-provisioner') definition.image = imageTag('db-migrate');
    // Only project-owned ports are exposed, bound to runner loopback.
    delete definition.ports;
    if (definition.depends_on) {
      for (const dependency of Object.keys(definition.depends_on)) {
        if (!services.includes(dependency))
          throw new Error(`Selected ${service} depends on omitted ${dependency}`);
      }
    }
    selected[service] = definition;
  }
  const postgres = selected.postgres;
  postgres.environment.WALG_ENABLED = 'off';
  postgres.command = [
    'postgres',
    '-c',
    'max_connections=300',
    '-c',
    'ssl=on',
    '-c',
    'ssl_cert_file=/run/aqua-postgres-tls/server.crt',
    '-c',
    'ssl_key_file=/run/aqua-postgres-tls/server.key',
    '-c',
    'ssl_ca_file=/run/aqua-postgres-tls/root.crt',
    '-c',
    'archive_mode=off',
  ];
  postgres.healthcheck = {
    test: ['CMD-SHELL', 'pg_isready -U aquaculture -d aquaculture_e2e'],
    interval: '5s',
    timeout: '5s',
    retries: 30,
  };
  postgres.volumes = postgres.volumes.filter(
    (mount) => mount.target !== '/var/lib/postgresql/wal-g-secrets-source',
  );
  postgres.ports = [{ target: 5432, published: '5432', host_ip: '127.0.0.1', protocol: 'tcp' }];
  selected.nginx.ports = [80, 443].map((port) => ({
    target: port,
    published: String(port),
    host_ip: '127.0.0.1',
    protocol: 'tcp',
  }));
  selected['gateway-api'].ports = [
    { target: 3000, published: '3000', host_ip: '127.0.0.1', protocol: 'tcp' },
  ];
  selected['admin-api-service'].ports = [
    { target: 3000, published: '3008', host_ip: '127.0.0.1', protocol: 'tcp' },
  ];
  for (const definition of Object.values(selected)) {
    for (const mount of definition.volumes || []) {
      if (mount.type !== 'bind') continue;
      if (mount.target === '/etc/nginx/nginx.conf') mount.source = join(state, 'nginx.conf');
      if (mount.target === '/etc/letsencrypt') mount.source = join(state, 'edge');
      if (mount.target === '/var/www/certbot') mount.source = join(state, 'certbot');
      const sourcePath = resolve(mount.source);
      if (!sourcePath.startsWith(`${root}/`) && !sourcePath.startsWith(`${state}/`))
        throw new Error(`Host bind outside candidate generation: ${mount.target}`);
      if (!existsSync(sourcePath)) throw new Error(`Missing candidate mount for ${mount.target}`);
    }
  }
  const volumes = Object.fromEntries(
    Object.keys(model.volumes).map((name) => [name, { name: `${project}_${name}` }]),
  );
  const networks = Object.fromEntries(
    Object.entries(model.networks).map(([name, network]) => [
      name,
      { ...network, name: `${project}_${name}` },
    ]),
  );
  privateFile(
    composePath,
    JSON.stringify({ name: project, services: selected, volumes, networks }, null, 2),
  );
  const testEnv = {
    HOSTED_E2E_ISOLATED: 'true',
    GATEWAY_URL: 'https://localhost',
    AQUAMOBIL_URL: 'https://localhost/mobile/',
    ADMIN_API_URL: 'http://127.0.0.1:3008',
    DATABASE_URL: `postgresql://aquaculture:${values.POSTGRES_PASSWORD}@127.0.0.1:5432/aquaculture_e2e`,
    PASSWORD_PEPPER: values.PASSWORD_PEPPER,
    MFA_ENCRYPTION_KEY: values.MFA_ENCRYPTION_KEY,
    SUPER_ADMIN_EMAIL: values.SUPER_ADMIN_EMAIL,
    SUPER_ADMIN_PASSWORD: values.SUPER_ADMIN_PASSWORD,
    NODE_EXTRA_CA_CERTS: join(tlsDirectory, 'fullchain.pem'),
  };
  for (const [key, value] of Object.entries(testEnv)) {
    if (/PASSWORD|PEPPER|KEY|DATABASE_URL/.test(key))
      process.stdout.write(`::add-mask::${value}\n`);
    appendFileSync(process.env.GITHUB_ENV, `${key}=${value}\n`);
  }
} else if (operation === 'build') {
  for (const service of catalog.backendImageTargets) {
    run('bash', ['tools/build/build-service.sh', service]);
    run('docker', [
      'build',
      '-f',
      service === 'db-migrate'
        ? 'infrastructure/docker/Dockerfile.db-migrate'
        : 'infrastructure/docker/Dockerfile.backend.simple',
      '--build-arg',
      `SERVICE_NAME=${service}`,
      '--label',
      `org.opencontainers.image.revision=${sha}`,
      '-t',
      imageTag(service),
      '.',
    ]);
  }
  for (const frontend of catalog.frontendImageMatrix) {
    if (frontend.module !== 'aquamobil')
      run('node', [
        'tools/toolchain/run.mjs',
        'nx',
        'build',
        frontend.nx_project,
        '--skip-nx-cache',
      ]);
    run('docker', [
      'build',
      '-f',
      frontend.dockerfile,
      '--build-arg',
      `MODULE_PATH=${frontend.module_path}`,
      '--label',
      `org.opencontainers.image.revision=${sha}`,
      '-t',
      imageTag(frontend.module),
      '.',
    ]);
  }
  const contract = createHash('sha256')
    .update(readFileSync('.github/manifests/postgres-dr-contract.sha256'))
    .digest('hex');
  for (const infra of catalog.infraImageMatrix) {
    run('docker', [
      'build',
      '-f',
      infra.dockerfile,
      '--build-arg',
      `BUILD_MAIN_SHA=${sha}`,
      '--build-arg',
      `POSTGRES_DR_CONTRACT_SHA256=${contract}`,
      '--label',
      `org.opencontainers.image.revision=${sha}`,
      '-t',
      imageTag(infra.image),
      infra.context,
    ]);
  }
  const built = images.map((service) => ({
    service,
    image_id: capture('docker', ['image', 'inspect', '--format', '{{.Id}}', imageTag(service)]),
  }));
  mkdirSync('artifacts/hosted-e2e', { recursive: true });
  writeFileSync(
    'artifacts/hosted-e2e/images.json',
    JSON.stringify(
      {
        base_sha: process.env.BASE_SHA,
        pr_head_sha: process.env.PR_HEAD_SHA,
        tested_merge_sha: sha,
        run_id: process.env.GITHUB_RUN_ID,
        run_attempt: process.env.GITHUB_RUN_ATTEMPT,
        images: built,
      },
      null,
      2,
    ),
  );
} else if (operation === 'up') {
  run('docker', [
    ...compose,
    'up',
    '--detach',
    '--wait',
    '--wait-timeout',
    '180',
    'postgres',
    'redis',
    'redis-auth',
    'nats',
    'minio',
    'mosquitto',
  ]);
  // db-migrate is the sole schema writer. Its failure prevents every app start.
  run('docker', [...compose, 'run', '--rm', '--no-deps', 'db-migrate']);
  run('docker', [
    ...compose,
    'up',
    '--detach',
    '--no-deps',
    ...services.filter(
      (service) =>
        !['postgres', 'redis', 'redis-auth', 'nats', 'minio', 'mosquitto', 'db-migrate'].includes(
          service,
        ),
    ),
  ]);
  run('curl', [
    '--fail',
    '--silent',
    '--show-error',
    '--retry',
    '90',
    '--retry-connrefused',
    '--retry-delay',
    '2',
    '--max-time',
    '10',
    'http://127.0.0.1:3000/health/ready',
  ]);
  run('curl', [
    '--fail',
    '--silent',
    '--show-error',
    '--cacert',
    process.env.NODE_EXTRA_CA_CERTS,
    'https://localhost/mobile/health',
  ]);
} else if (operation === 'reset-rate-limits') {
  // Each suite owns fresh counting windows; preserve sessions and revocation state.
  const values = JSON.parse(readFileSync(join(state, 'runtime.json'), 'utf8'));
  const redisEnv = { ...process.env, REDISCLI_AUTH: values.REDIS_PASSWORD };
  const cli = [...compose, 'exec', '--no-TTY', '--env', 'REDISCLI_AUTH', 'redis', 'redis-cli'];
  const keys = capture('docker', [...cli, '--scan', '--pattern', 'ratelimit:*'], { env: redisEnv })
    .split('\n')
    .filter(Boolean);
  if (keys.some((key) => !key.startsWith('ratelimit:')))
    throw new Error('Unexpected fixture counter namespace');
  if (keys.length) run('docker', [...cli, 'DEL', ...keys], { env: redisEnv, stdio: 'ignore' });
} else if (operation === 'diagnose') {
  const directory = join(root, 'artifacts', 'hosted-e2e', 'runtime');
  mkdirSync(directory, { recursive: true });
  if (existsSync(composePath)) {
    const values = JSON.parse(readFileSync(join(state, 'runtime.json'), 'utf8'));
    const secrets = Object.entries(values)
      .filter(([key]) => /PASSWORD|PASS|SECRET|TOKEN|KEY/.test(key))
      .map(([, value]) => value);
    // Logs may render a keyring member independently of the full environment JSON.
    for (const key of JSON.parse(values.SERVICE_IDENTITY_KEYRING)) secrets.push(key.secret);
    const redact = (text) =>
      secrets.reduce((output, secret) => output.replaceAll(secret, '[REDACTED]'), text);
    const commands = [
      ['status', [...compose, 'ps', '--all', '--format', 'json']],
      ['logs', [...compose, 'logs', '--no-color', '--timestamps', '--tail', '160']],
    ];
    for (const [name, args] of commands) {
      const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      writeFileSync(
        join(directory, `${name}.txt`),
        redact(`${result.stdout ?? ''}\n${result.stderr ?? ''}`),
      );
    }
    const containers = capture('docker', [...compose, 'ps', '--all', '--quiet'])
      .split('\n')
      .filter(Boolean);
    const states = containers.map((id) =>
      JSON.parse(
        capture('docker', [
          'inspect',
          '--format',
          '{"name":{{json .Name}},"image_id":{{json .Image}},"state":{{json .State}}}',
          id,
        ]),
      ),
    );
    writeFileSync(join(directory, 'states.json'), redact(JSON.stringify(states, null, 2)));
  }
} else if (operation === 'down') {
  if (existsSync(composePath))
    run('docker', [...compose, 'down', '--volumes', '--remove-orphans', '--timeout', '30']);
} else {
  throw new Error('Expected prepare, build, up, reset-rate-limits, diagnose or down');
}
