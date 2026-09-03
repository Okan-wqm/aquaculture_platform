import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import * as YAML from 'yaml';

interface ResolvedRange {
  readonly baseSha: string;
  readonly headSha: string;
  readonly fullValidation: boolean;
  readonly reason: string;
}

interface DeploymentScope {
  readonly affectedProjects?: string[];
  readonly dependencyAuditRequired: boolean;
  readonly backendMatrix: Array<{ readonly service: string; readonly dockerfile: string }>;
  readonly deployServices: string[];
  readonly frontendMatrix: Array<{ readonly module: string }>;
  readonly fullDeploy: boolean;
  readonly farmChecksRequired: boolean;
  readonly infraMatrix: Array<{ readonly image: string }>;
  readonly migrationRequired: boolean;
  readonly reason: string;
  readonly rustChecksRequired: boolean;
  readonly sensorChecksRequired: boolean;
  readonly changedFiles?: string[];
  readonly validationRequired?: boolean;
}

const REPO_ROOT = resolve(__dirname, '..', '..');
const RANGE_RESOLVER = join(REPO_ROOT, 'scripts', 'ci', 'resolve-affected-range.ts');
const SCOPE_SELECTOR = join(REPO_ROOT, 'scripts', 'ci', 'select-deployment-scope.ts');
const TYPE_CHECK_CHANGED_FILES = join(REPO_ROOT, 'scripts', 'ci', 'type-check-changed-files.mjs');
const LINT_CHANGED_FILES = join(REPO_ROOT, 'scripts', 'ci', 'lint-changed-files.mjs');
const TYPE_CHECK_BOOTSTRAP_BASELINE = 'scripts/ci/type-check-bootstrap-unowned-baseline.txt';
const SENS_SPECIALIST_REQUIRED_PATH_FILTERS = [
  'sens-api-gateway/**',
  'Cargo.toml',
  'Cargo.lock',
  'crates/**',
  'tools/executors/cargo/**',
  'tools/gates/**',
  '.github/manifests/**',
  'package.json',
  'package-lock.json',
] as const;

function git(repo: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function commit(repo: string, file: string, contents: string, message: string): string {
  writeFileSync(join(repo, file), contents);
  git(repo, 'add', file);
  git(repo, 'commit', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function fixtureRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), 'aqua-affected-range-'));
  git(repo, 'init', '--initial-branch=main');
  git(repo, 'config', 'user.email', 'ci-test@example.invalid');
  git(repo, 'config', 'user.name', 'CI Test');
  mkdirSync(join(repo, '.github', 'manifests'), { recursive: true });
  writeFileSync(
    join(repo, '.github', 'manifests', 'main-required-status-checks.json'),
    JSON.stringify({
      ci_affected_required_path_filters: SENS_SPECIALIST_REQUIRED_PATH_FILTERS,
      sens_specialist_required_path_filters: SENS_SPECIALIST_REQUIRED_PATH_FILTERS,
    }),
  );
  return repo;
}

function selectorFixtureRepository(sensSpecialistRequiredPathFilters: readonly string[]): string {
  const repo = mkdtempSync(join(tmpdir(), 'aqua-selector-'));
  mkdirSync(join(repo, '.github', 'manifests'), { recursive: true });
  mkdirSync(join(repo, 'infrastructure', 'deploy'), { recursive: true });
  writeFileSync(
    join(repo, '.github', 'manifests', 'main-required-status-checks.json'),
    JSON.stringify({
      ci_affected_required_path_filters: [...sensSpecialistRequiredPathFilters],
      sens_specialist_required_path_filters: [...sensSpecialistRequiredPathFilters],
    }),
  );
  writeFileSync(
    join(repo, 'infrastructure', 'deploy', 'service-catalog.generated.json'),
    JSON.stringify({
      dbSchemas: [],
      deploy: {
        backendImageTargets: [],
        frontendImageMatrix: [],
        frontendImageTargets: [],
        infraImageMatrix: [],
        infraImageTargets: [],
      },
    }),
  );
  return repo;
}

function resolveRange(repo: string, args: readonly string[]): ResolvedRange {
  const result = spawnSync(process.execPath, [RANGE_RESOLVER, '--repo', repo, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as ResolvedRange;
}

function selectScope(
  changedFiles: readonly string[],
  affectedProjects: readonly string[],
  requestedServices = 'auto',
  fullValidation = false,
): DeploymentScope {
  return selectScopeForRepository(
    REPO_ROOT,
    changedFiles,
    affectedProjects,
    requestedServices,
    fullValidation,
  );
}

function selectScopeForRepository(
  repo: string,
  changedFiles: readonly string[],
  affectedProjects: readonly string[],
  requestedServices = 'auto',
  fullValidation = false,
): DeploymentScope {
  const result = spawnSync(
    process.execPath,
    [
      SCOPE_SELECTOR,
      '--repo',
      repo,
      '--requested-services',
      requestedServices,
      '--channel',
      'development',
      '--changed-files-json',
      JSON.stringify(changedFiles),
      '--affected-projects-json',
      JSON.stringify(affectedProjects),
      ...(fullValidation ? ['--full-validation'] : []),
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as DeploymentScope;
}

function selectRangeScope(repo: string, baseSha: string, headSha: string): DeploymentScope {
  const result = spawnSync(
    process.execPath,
    [
      SCOPE_SELECTOR,
      '--repo',
      repo,
      '--requested-services',
      'auto',
      '--channel',
      'development',
      '--base-sha',
      baseSha,
      '--head-sha',
      headSha,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as DeploymentScope;
}

function typeCheckBootstrapFixture(baselineEntries: readonly string[]): {
  readonly headSha: string;
  readonly repo: string;
} {
  const repo = fixtureRepository();
  mkdirSync(join(repo, 'apps', 'owned', 'src'), { recursive: true });
  mkdirSync(join(repo, 'apps', 'owned', 'test'), { recursive: true });
  mkdirSync(join(repo, 'libs', 'inherited', 'src'), { recursive: true });
  mkdirSync(join(repo, 'node_modules', 'typescript', 'bin'), { recursive: true });
  mkdirSync(join(repo, 'scripts', 'ci'), { recursive: true });
  writeFileSync(
    join(repo, 'tsconfig.base.json'),
    JSON.stringify({ compilerOptions: { strict: true, types: [] } }),
  );
  writeFileSync(
    join(repo, 'apps', 'owned', 'tsconfig.app.json'),
    JSON.stringify({ extends: '../../tsconfig.base.json', include: ['src/**/*.ts'] }),
  );
  writeFileSync(
    join(repo, 'apps', 'owned', 'tsconfig.spec.json'),
    JSON.stringify({ extends: './tsconfig.app.json', include: ['src/**/*.spec.ts'] }),
  );
  writeFileSync(
    join(repo, 'apps', 'owned', 'tsconfig.e2e.json'),
    JSON.stringify({ extends: './tsconfig.spec.json', include: ['test/**/*.ts'] }),
  );
  writeFileSync(join(repo, 'apps', 'owned', 'src', 'index.ts'), 'export const owned = true;\n');
  writeFileSync(
    join(repo, 'apps', 'owned', 'test', 'workflow.e2e-spec.ts'),
    'export const e2e = true;\n',
  );
  writeFileSync(
    join(repo, 'libs', 'inherited', 'src', 'index.ts'),
    'export const inherited = true;\n',
  );
  writeFileSync(join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), 'process.exitCode = 0;\n');
  writeFileSync(
    join(repo, TYPE_CHECK_BOOTSTRAP_BASELINE),
    `${[...baselineEntries].sort().join('\n')}\n`,
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'bootstrap fixture');
  return { headSha: git(repo, 'rev-parse', 'HEAD'), repo };
}

function runChangedFileTypeCheck(
  repo: string,
  baseSha: string,
  headSha: string,
): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [TYPE_CHECK_CHANGED_FILES, '--base', baseSha, '--head', headSha],
    { cwd: repo, encoding: 'utf8' },
  );
}

function representativePathForGlob(filter: string): string {
  return filter.replaceAll('**', 'README.md').replaceAll('*', 'README.md');
}

describe('affected CI range resolver', () => {
  it('uses the immutable pull request base SHA and requested merge SHA', () => {
    const repo = fixtureRepository();
    try {
      const baseSha = commit(repo, 'base.txt', 'base\n', 'base');
      const headSha = commit(repo, 'head.txt', 'head\n', 'head');

      expect(
        resolveRange(repo, [
          '--event-name',
          'pull_request',
          '--head-sha',
          headSha,
          '--pr-base-sha',
          baseSha,
        ]),
      ).toEqual({
        baseSha,
        headSha,
        fullValidation: false,
        reason: 'pull-request-base',
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('uses the last successful development deployment as the main push baseline', () => {
    const repo = fixtureRepository();
    try {
      const deployedSha = commit(repo, 'deployed.txt', 'deployed\n', 'deployed');
      git(repo, 'tag', 'deployed/development', deployedSha);
      const headSha = commit(repo, 'next.txt', 'next\n', 'next');

      expect(
        resolveRange(repo, [
          '--event-name',
          'push',
          '--ref',
          'refs/heads/main',
          '--head-sha',
          headSha,
          '--development-ref',
          'deployed/development',
        ]),
      ).toEqual({
        baseSha: deployedSha,
        headSha,
        fullValidation: false,
        reason: 'development-deploy-baseline',
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('requests a full first rollout when the development baseline is missing', () => {
    const repo = fixtureRepository();
    try {
      const headSha = commit(repo, 'first.txt', 'first\n', 'first');

      expect(
        resolveRange(repo, [
          '--event-name',
          'push',
          '--ref',
          'refs/heads/main',
          '--head-sha',
          headSha,
          '--development-ref',
          'deployed/development',
        ]),
      ).toEqual({
        // The full-rollout base is the repository's ROOT COMMIT — a real
        // commit every consumer can diff against (root..head = the whole
        // history = every project affected). The empty-tree sentinel this
        // replaced looked like a SHA but made `git diff base...head` fatal
        // ("is a tree, not a commit"), turning the FIRST push after the
        // lane merged into a permanent red main.
        baseSha: headSha, // single-commit fixture: its own root
        headSha,
        fullValidation: true,
        reason: 'development-baseline-missing',
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('requests full validation when the development baseline is not an ancestor', () => {
    const repo = fixtureRepository();
    try {
      const rootSha = commit(repo, 'root.txt', 'root\n', 'root');
      git(repo, 'switch', '--create', 'old-release');
      const staleSha = commit(repo, 'stale.txt', 'stale\n', 'stale');
      git(repo, 'tag', 'deployed/development', staleSha);
      git(repo, 'switch', 'main');
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(rootSha);
      const headSha = commit(repo, 'main.txt', 'main\n', 'main');

      expect(
        resolveRange(repo, [
          '--event-name',
          'push',
          '--ref',
          'refs/heads/main',
          '--head-sha',
          headSha,
          '--development-ref',
          'deployed/development',
        ]),
      ).toEqual({
        // Root-commit base (see the missing-baseline case): a stale,
        // non-ancestor deployment tag must not produce a diff base that
        // kills the CI jobs with "is a tree, not a commit".
        baseSha: rootSha,
        headSha,
        fullValidation: true,
        reason: 'development-baseline-not-ancestor',
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('requests full validation when the development ref does not resolve to a commit', () => {
    const repo = fixtureRepository();
    try {
      const headSha = commit(repo, 'main.txt', 'main\n', 'main');
      writeFileSync(join(repo, 'not-a-commit.txt'), 'blob\n');
      const blobSha = git(repo, 'hash-object', '-w', 'not-a-commit.txt');
      git(repo, 'update-ref', 'refs/tags/deployed/development', blobSha);

      expect(
        resolveRange(repo, [
          '--event-name',
          'push',
          '--ref',
          'refs/heads/main',
          '--head-sha',
          headSha,
          '--development-ref',
          'deployed/development',
        ]),
      ).toEqual({
        // Root-commit base (see the missing-baseline case): a baseline
        // ref pointing at a BLOB must degrade to a diffable commit, never
        // to the empty-tree sentinel that made `git diff base...head`
        // fatal.
        baseSha: headSha, // single-commit fixture: its own root
        headSha,
        fullValidation: true,
        reason: 'development-baseline-invalid',
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('keeps the successful baseline fixed so a failed deploy is included in the next range', () => {
    const repo = fixtureRepository();
    try {
      const deployedSha = commit(repo, 'deployed.txt', 'deployed\n', 'deployed');
      git(repo, 'tag', 'deployed/development', deployedSha);
      const failedDeploySha = commit(repo, 'failed.txt', 'failed\n', 'failed deploy');
      const headSha = commit(repo, 'recovery.txt', 'recovery\n', 'recovery');

      const range = resolveRange(repo, [
        '--event-name',
        'push',
        '--ref',
        'refs/heads/main',
        '--head-sha',
        headSha,
        '--development-ref',
        'deployed/development',
      ]);

      expect(range.baseSha).toBe(deployedSha);
      expect(git(repo, 'diff', '--name-only', range.baseSha, range.headSha).split('\n')).toEqual([
        'failed.txt',
        'recovery.txt',
      ]);
      expect(git(repo, 'rev-parse', 'deployed/development')).not.toBe(failedDeploySha);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('development image and deploy scope selector', () => {
  it('selects one changed backend plus db-migrate and no unrelated image group', () => {
    const scope = selectScope(
      ['apps/farm-service/src/farm/services/farm.service.ts'],
      ['farm-service'],
    );

    expect(scope).toMatchObject({
      deployServices: ['db-migrate', 'farm-service'],
      frontendMatrix: [],
      fullDeploy: false,
      infraMatrix: [],
      migrationRequired: true,
      reason: 'nx-affected',
    });
    expect(scope.backendMatrix).toEqual([
      {
        service: 'db-migrate',
        dockerfile: 'infrastructure/docker/Dockerfile.db-migrate',
      },
      {
        service: 'farm-service',
        dockerfile: 'infrastructure/docker/Dockerfile.backend.simple',
      },
    ]);
  });

  it('keeps a single frontend deployment frontend-only and skips migrations', () => {
    const scope = selectScope(['web/modules/dashboard/src/App.tsx'], ['dashboard']);

    expect(scope.backendMatrix).toEqual([]);
    expect(scope.deployServices).toEqual(['dashboard']);
    expect(scope.frontendMatrix.map((entry) => entry.module)).toEqual(['dashboard']);
    expect(scope.infraMatrix).toEqual([]);
    expect(scope.migrationRequired).toBe(false);
  });

  it('maps the AquaMobil package Nx identity to its self-building frontend image', () => {
    const scope = selectScope(['web/apps/aquamobil/src/App.tsx'], ['@aquaculture/aquamobil']);

    expect(scope.backendMatrix).toEqual([]);
    expect(scope.deployServices).toEqual(['aquamobil']);
    expect(scope.frontendMatrix.map((entry) => entry.module)).toEqual(['aquamobil']);
    expect(scope.infraMatrix).toEqual([]);
    expect(scope.migrationRequired).toBe(false);
  });

  it('uses Nx consumers for shared-ui instead of rebuilding every frontend', () => {
    const scope = selectScope(
      ['web/shared-ui/src/components/Button.tsx'],
      ['shared-ui', 'shell', 'dashboard', 'farm-module'],
    );

    expect(scope.deployServices).toEqual(['shell', 'dashboard', 'farm-module']);
    expect(scope.frontendMatrix.map((entry) => entry.module)).toEqual([
      'shell',
      'dashboard',
      'farm-module',
    ]);
  });

  it('uses Nx transitive consumers for shared event contracts', () => {
    const scope = selectScope(
      ['libs/event-contracts/src/farm-events.ts'],
      ['event-contracts', 'gateway-api', 'farm-service', 'notification-service'],
    );

    expect(scope.deployServices).toEqual([
      'db-migrate',
      'gateway-api',
      'farm-service',
      'notification-service',
    ]);
    expect(scope.migrationRequired).toBe(true);
  });

  it('resolves a migration file to its catalog owner and db-migrate', () => {
    const scope = selectScope(
      ['apps/farm-service/src/database/migrations/1780000000000-AddField.ts'],
      [],
    );

    expect(scope.deployServices).toEqual(['db-migrate', 'farm-service']);
    expect(scope.reason).toBe('migration-owner');
  });

  it('rebuilds only the backend image group for the common backend Dockerfile', () => {
    const scope = selectScope(['infrastructure/docker/Dockerfile.backend.simple'], []);

    expect(scope.backendMatrix).toHaveLength(16);
    expect(scope.frontendMatrix).toEqual([]);
    expect(scope.infraMatrix).toEqual([]);
    expect(scope.fullDeploy).toBe(false);
    expect(scope.reason).toBe('backend-dockerfile-group');
  });

  it('rebuilds db-migrate when its dedicated Dockerfile changes', () => {
    const scope = selectScope(['infrastructure/docker/Dockerfile.db-migrate'], []);

    expect(scope.deployServices).toEqual(['db-migrate']);
    expect(scope.backendMatrix).toEqual([
      {
        service: 'db-migrate',
        dockerfile: 'infrastructure/docker/Dockerfile.db-migrate',
      },
    ]);
    expect(scope.frontendMatrix).toEqual([]);
    expect(scope.infraMatrix).toEqual([]);
    expect(scope.migrationRequired).toBe(true);
    expect(scope.reason).toBe('db-migrate-dockerfile');
  });

  it('rebuilds only images that consume the common microfrontend Dockerfile', () => {
    const scope = selectScope(['infrastructure/docker/Dockerfile.microfrontend.simple'], []);

    expect(scope.backendMatrix).toEqual([]);
    expect(scope.frontendMatrix.map((entry) => entry.module)).toEqual([
      'dashboard',
      'farm-module',
      'sensor-module',
      'hr-module',
      'hydroponics-module',
      'messaging-module',
      'admin-panel',
      'tenant-admin',
    ]);
    expect(scope.infraMatrix).toEqual([]);
    expect(scope.migrationRequired).toBe(false);
  });

  it.each([
    [
      'infrastructure/docker/nginx/microfrontend.conf',
      [
        'dashboard',
        'farm-module',
        'sensor-module',
        'hr-module',
        'hydroponics-module',
        'messaging-module',
        'admin-panel',
        'tenant-admin',
      ],
    ],
    ['infrastructure/docker/nginx/shell.conf', ['shell']],
    ['infrastructure/docker/scripts/40-create-runtime-config.sh', ['shell']],
    ['infrastructure/docker/nginx/aquamobil.conf', ['aquamobil']],
    ['infrastructure/docker/nginx/snippets/security-headers.conf', ['aquamobil']],
  ])('selects every frontend image whose Docker build consumes %s', (changedFile, modules) => {
    const scope = selectScope([changedFile], []);

    expect(scope.backendMatrix).toEqual([]);
    expect(scope.deployServices).toEqual(modules);
    expect(scope.frontendMatrix.map((entry) => entry.module)).toEqual(modules);
    expect(scope.infraMatrix).toEqual([]);
    expect(scope.migrationRequired).toBe(false);
    expect(scope.reason).toBe('frontend-build-input');
  });

  it.each([
    [
      'infrastructure/docker/scripts/postgres-walg-healthcheck.sh',
      'postgres',
      'infrastructure/docker/Dockerfile.postgres-walg',
    ],
    [
      'infrastructure/mosquitto/mosquitto-production.conf',
      'mosquitto',
      'infrastructure/mosquitto/Dockerfile',
    ],
  ])('selects the consuming infra image when %s changes', (changedFile, image, dockerfile) => {
    const scope = selectScope([changedFile], []);

    expect(scope.deployServices).toEqual(['db-migrate', image]);
    expect(scope.backendMatrix.map((entry) => entry.service)).toEqual(['db-migrate']);
    expect(scope.frontendMatrix).toEqual([]);
    expect(scope.infraMatrix).toEqual([
      expect.objectContaining({
        image,
        dockerfile,
      }),
    ]);
    expect(scope.migrationRequired).toBe(true);
    expect(scope.reason).toBe('infra-build-input');
  });

  it.each([
    ['.dockerignore', 'workspace-global-input'],
    ['package-lock.json', 'workspace-global-input'],
    ['docker-compose.droplet.yml', 'deploy-control-plane'],
    ['infrastructure/nats/services.yaml', 'deploy-control-plane'],
  ])('selects a full image/deploy scope for %s', (changedFile, reason) => {
    const scope = selectScope([changedFile], []);

    expect(scope.backendMatrix).toHaveLength(16);
    expect(scope.frontendMatrix).toHaveLength(10);
    expect(scope.infraMatrix).toHaveLength(2);
    expect(scope.fullDeploy).toBe(true);
    expect(scope.migrationRequired).toBe(true);
    expect(scope.reason).toBe(reason);
  });

  it('produces no image or deploy for documentation-only changes', () => {
    expect(selectScope(['docs/DEPLOY.md'], [])).toMatchObject({
      backendMatrix: [],
      deployServices: [],
      frontendMatrix: [],
      fullDeploy: false,
      infraMatrix: [],
      migrationRequired: false,
      reason: 'docs-only',
      rustChecksRequired: false,
      sensorChecksRequired: false,
      validationRequired: false,
    });
  });

  it('makes an explicit all request a full deploy', () => {
    const scope = selectScope([], [], 'all');

    expect(scope.backendMatrix).toHaveLength(16);
    expect(scope.frontendMatrix).toHaveLength(10);
    expect(scope.infraMatrix).toHaveLength(2);
    expect(scope.fullDeploy).toBe(true);
    expect(scope.reason).toBe('requested-all');
  });

  it('supports a validated CSV service override while preserving frontend-only safety', () => {
    const scope = selectScope([], [], 'dashboard,shell');

    expect(scope.deployServices).toEqual(['shell', 'dashboard']);
    expect(scope.backendMatrix).toEqual([]);
    expect(scope.migrationRequired).toBe(false);
    expect(scope.reason).toBe('requested-services');
  });

  it('adds db-migrate to an infra-only request because it is not proven frontend-only', () => {
    const scope = selectScope([], [], 'mosquitto');

    expect(scope.deployServices).toEqual(['db-migrate', 'mosquitto']);
    expect(scope.migrationRequired).toBe(true);
  });

  it('forces every image and specialist check for the first development rollout', () => {
    const scope = selectScope(['README.md'], [], 'auto', true);

    expect(scope.fullDeploy).toBe(true);
    expect(scope.reason).toBe('full-validation');
    expect(scope).toMatchObject({
      dependencyAuditRequired: true,
      farmChecksRequired: true,
      rustChecksRequired: true,
      sensorChecksRequired: true,
    });
  });

  it('exposes specialist checks only for their affected paths and projects', () => {
    expect(
      selectScope(['apps/farm-service/src/farm/farm.module.ts'], ['farm-service']),
    ).toMatchObject({
      dependencyAuditRequired: false,
      farmChecksRequired: true,
      rustChecksRequired: false,
      sensorChecksRequired: false,
    });
    expect(selectScope(['sens-api-gateway/src/main.rs'], ['sensor-ingestion'])).toMatchObject({
      dependencyAuditRequired: false,
      farmChecksRequired: false,
      rustChecksRequired: true,
      sensorChecksRequired: true,
    });
    expect(selectScope(['package-lock.json'], [])).toMatchObject({
      dependencyAuditRequired: true,
      farmChecksRequired: true,
      rustChecksRequired: true,
      sensorChecksRequired: true,
    });
    expect(selectScope(['.github/workflows/deploy-development.yml'], [])).toMatchObject({
      dependencyAuditRequired: false,
      farmChecksRequired: false,
      fullDeploy: true,
      rustChecksRequired: false,
      sensorChecksRequired: false,
    });
  });

  it.each(SENS_SPECIALIST_REQUIRED_PATH_FILTERS)(
    'requires validation and both Sens specialists for %s',
    (filter) => {
      const requiredChecks = JSON.parse(
        readFileSync(join(REPO_ROOT, '.github/manifests/main-required-status-checks.json'), 'utf8'),
      ) as { sens_specialist_required_path_filters?: string[] };

      expect(requiredChecks.sens_specialist_required_path_filters).toEqual(
        SENS_SPECIALIST_REQUIRED_PATH_FILTERS,
      );
      const scope = selectScope([representativePathForGlob(filter)], []);
      expect(scope).toMatchObject({
        validationRequired: true,
        sensorChecksRequired: true,
        rustChecksRequired: true,
      });
    },
  );

  it.each(['sens-api-gateway/README.md', 'tools/gates/README.md'])(
    'keeps governed docs-only path %s out of image and deploy scope',
    (changedFile) => {
      expect(selectScope([changedFile], [])).toMatchObject({
        backendMatrix: [],
        deployServices: [],
        frontendMatrix: [],
        infraMatrix: [],
        reason: 'docs-only',
        rustChecksRequired: true,
        sensorChecksRequired: true,
        validationRequired: true,
      });
    },
  );

  it.each([
    'tools/backup-ssh-broker/README.md',
    'infrastructure/scripts/README.md',
    'tests/README.md',
  ])('validates general CI-required docs-only path %s without selecting images', (changedFile) => {
    expect(selectScope([changedFile], [])).toMatchObject({
      backendMatrix: [],
      deployServices: [],
      frontendMatrix: [],
      infraMatrix: [],
      reason: 'docs-only',
      rustChecksRequired: false,
      sensorChecksRequired: false,
      validationRequired: true,
    });
  });

  it('uses the target repository manifest for docs-only specialist coverage', () => {
    const repo = selectorFixtureRepository(['target-specialist/**']);
    try {
      expect(selectScopeForRepository(repo, ['target-specialist/README.md'], [])).toMatchObject({
        backendMatrix: [],
        deployServices: [],
        frontendMatrix: [],
        infraMatrix: [],
        reason: 'docs-only',
        rustChecksRequired: true,
        sensorChecksRequired: true,
        validationRequired: true,
      });
      expect(selectScopeForRepository(repo, ['tools/gates/README.md'], [])).toMatchObject({
        backendMatrix: [],
        deployServices: [],
        frontendMatrix: [],
        infraMatrix: [],
        reason: 'docs-only',
        rustChecksRequired: false,
        sensorChecksRequired: false,
        validationRequired: false,
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('derives changed files and Nx affected projects from the exact requested SHA range', () => {
    const repo = fixtureRepository();
    try {
      mkdirSync(join(repo, 'infrastructure', 'deploy'), { recursive: true });
      mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(
        join(repo, 'infrastructure', 'deploy', 'service-catalog.generated.json'),
        JSON.stringify({
          dbSchemas: [],
          deploy: {
            backendImageTargets: ['db-migrate', 'farm-service'],
            frontendImageMatrix: [],
            frontendImageTargets: [],
            infraImageMatrix: [],
            infraImageTargets: [],
          },
        }),
      );
      writeFileSync(
        join(repo, 'node_modules', '.bin', 'nx'),
        "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(['farm-service']));\n",
      );
      chmodSync(join(repo, 'node_modules', '.bin', 'nx'), 0o755);
      writeFileSync(join(repo, 'baseline.txt'), 'baseline\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'baseline');
      const baseSha = git(repo, 'rev-parse', 'HEAD');
      mkdirSync(join(repo, 'apps', 'farm-service', 'src'), { recursive: true });
      const headSha = commit(
        repo,
        'apps/farm-service/src/farm.service.ts',
        'export const farm = true;\n',
        'farm change',
      );

      expect(selectRangeScope(repo, baseSha, headSha)).toMatchObject({
        affectedProjects: ['farm-service'],
        changedFiles: ['apps/farm-service/src/farm.service.ts'],
        deployServices: ['db-migrate', 'farm-service'],
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('enumerates the head tree for a first rollout', () => {
    const repo = fixtureRepository();
    try {
      mkdirSync(join(repo, 'infrastructure', 'deploy'), { recursive: true });
      mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(
        join(repo, 'infrastructure', 'deploy', 'service-catalog.generated.json'),
        JSON.stringify({
          dbSchemas: [],
          deploy: {
            backendImageTargets: ['db-migrate', 'farm-service'],
            frontendImageMatrix: [],
            frontendImageTargets: [],
            infraImageMatrix: [],
            infraImageTargets: [],
          },
        }),
      );
      writeFileSync(
        join(repo, 'node_modules', '.bin', 'nx'),
        "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(['farm-service']));\n",
      );
      chmodSync(join(repo, 'node_modules', '.bin', 'nx'), 0o755);
      writeFileSync(join(repo, 'application.ts'), 'export const application = true;\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'first rollout');
      const headSha = git(repo, 'rev-parse', 'HEAD');

      expect(
        selectRangeScope(repo, '4b825dc642cb6eb9a060e54bf8d69288fbee4904', headSha),
      ).toMatchObject({
        affectedProjects: ['farm-service'],
        changedFiles: expect.arrayContaining([
          'application.ts',
          'infrastructure/deploy/service-catalog.generated.json',
        ]),
        deployServices: ['db-migrate', 'farm-service'],
        fullDeploy: true,
        reason: 'full-validation',
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('keeps deleted files in the immutable range so deletion-only merges are validated', () => {
    const repo = fixtureRepository();
    try {
      mkdirSync(join(repo, 'infrastructure', 'deploy'), { recursive: true });
      mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
      mkdirSync(join(repo, 'apps', 'farm-service', 'src'), { recursive: true });
      writeFileSync(
        join(repo, 'infrastructure', 'deploy', 'service-catalog.generated.json'),
        JSON.stringify({
          dbSchemas: [],
          deploy: {
            backendImageTargets: ['db-migrate', 'farm-service'],
            frontendImageMatrix: [],
            frontendImageTargets: [],
            infraImageMatrix: [],
            infraImageTargets: [],
          },
        }),
      );
      writeFileSync(
        join(repo, 'node_modules', '.bin', 'nx'),
        "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(['farm-service']));\n",
      );
      chmodSync(join(repo, 'node_modules', '.bin', 'nx'), 0o755);
      writeFileSync(
        join(repo, 'apps', 'farm-service', 'src', 'removed.ts'),
        'export const removed = true;\n',
      );
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'baseline');
      const baseSha = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'rm', 'apps/farm-service/src/removed.ts');
      git(repo, 'commit', '-m', 'delete farm source');
      const headSha = git(repo, 'rev-parse', 'HEAD');

      expect(selectRangeScope(repo, baseSha, headSha)).toMatchObject({
        changedFiles: ['apps/farm-service/src/removed.ts'],
        deployServices: ['db-migrate', 'farm-service'],
        validationRequired: true,
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('keeps type changes in the immutable range so their image and deploy scope is not skipped', () => {
    const repo = fixtureRepository();
    try {
      mkdirSync(join(repo, 'infrastructure', 'deploy'), { recursive: true });
      mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
      mkdirSync(join(repo, 'apps', 'farm-service', 'src'), { recursive: true });
      writeFileSync(
        join(repo, 'infrastructure', 'deploy', 'service-catalog.generated.json'),
        JSON.stringify({
          dbSchemas: [],
          deploy: {
            backendImageTargets: ['db-migrate', 'farm-service'],
            frontendImageMatrix: [],
            frontendImageTargets: [],
            infraImageMatrix: [],
            infraImageTargets: [],
          },
        }),
      );
      writeFileSync(
        join(repo, 'node_modules', '.bin', 'nx'),
        "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(['farm-service']));\n",
      );
      chmodSync(join(repo, 'node_modules', '.bin', 'nx'), 0o755);
      const changedFile = 'apps/farm-service/src/farm.service.ts';
      writeFileSync(join(repo, changedFile), 'export const farm = true;\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'baseline');
      const baseSha = git(repo, 'rev-parse', 'HEAD');
      rmSync(join(repo, changedFile));
      symlinkSync('farm.service.target.ts', join(repo, changedFile));
      git(repo, 'add', '--all');
      git(repo, 'commit', '-m', 'change farm source type');
      const headSha = git(repo, 'rev-parse', 'HEAD');

      expect(selectRangeScope(repo, baseSha, headSha)).toMatchObject({
        affectedProjects: ['farm-service'],
        changedFiles: [changedFile],
        deployServices: ['db-migrate', 'farm-service'],
        validationRequired: true,
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('Nx affected graph inputs', () => {
  it('lets project imports determine shared library consumers instead of global invalidation', () => {
    const nx = JSON.parse(readFileSync(join(REPO_ROOT, 'nx.json'), 'utf8')) as {
      namedInputs?: { sharedGlobals?: string[] };
    };
    const sharedGlobals = nx.namedInputs?.sharedGlobals ?? [];

    expect(sharedGlobals).not.toContain('{workspaceRoot}/libs/*/src/**/*.ts');
    expect(sharedGlobals).not.toContain('{workspaceRoot}/platform/libs/*/src/**/*.ts');
    expect(sharedGlobals).toEqual(
      expect.arrayContaining([
        '{workspaceRoot}/tsconfig.base.json',
        '{workspaceRoot}/tools/build/**',
      ]),
    );
  });
});

describe('first-rollout type-check ownership baseline', () => {
  const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

  it('gives executable tool scripts an ESM-compatible tsconfig owner', () => {
    const configPath = join(REPO_ROOT, 'tools', 'scripts', 'tsconfig.json');

    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      compilerOptions?: { module?: string; moduleResolution?: string };
    };
    expect(config.compilerOptions).toMatchObject({
      module: 'ESNext',
      moduleResolution: 'Bundler',
    });
  });

  it('admits only the exact inherited unowned set for the empty-tree bootstrap', () => {
    const { headSha, repo } = typeCheckBootstrapFixture(['libs/inherited/src/index.ts']);
    try {
      const result = runChangedFileTypeCheck(repo, emptyTree, headSha);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('bootstrap inherited unowned TypeScript: 1 file(s)');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('uses a service dedicated e2e tsconfig for its e2e sources', () => {
    const { headSha, repo } = typeCheckBootstrapFixture(['libs/inherited/src/index.ts']);
    try {
      const result = runChangedFileTypeCheck(repo, emptyTree, headSha);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('apps/owned/tsconfig.e2e.json');
      expect(result.stdout).not.toContain('apps/owned/tsconfig.spec.json');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('removes temporary compiler configs after success and failure', () => {
    const { headSha, repo } = typeCheckBootstrapFixture(['libs/inherited/src/index.ts']);
    const tempRoot = join(repo, '.aria-ci');
    try {
      const success = runChangedFileTypeCheck(repo, emptyTree, headSha);

      expect(success.status).toBe(0);
      expect(readdirSync(tempRoot)).toEqual([]);

      writeFileSync(
        join(repo, 'node_modules', 'typescript', 'bin', 'tsc'),
        'process.exitCode = 1;\n',
      );
      const failure = runChangedFileTypeCheck(repo, emptyTree, headSha);

      expect(failure.status).toBe(1);
      expect(readdirSync(tempRoot)).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('keeps forensic migration archives outside bootstrap compilation', () => {
    const { repo } = typeCheckBootstrapFixture(['libs/inherited/src/index.ts']);
    const archivedMigration =
      'apps/owned/src/database/migrations/.archive/2026-01-01/1700000000000-Retired.ts';
    try {
      mkdirSync(join(repo, archivedMigration, '..'), { recursive: true });
      const headSha = commit(
        repo,
        archivedMigration,
        "import { retiredHelper } from './retired-helper';\nexport const retired = retiredHelper;\n",
        'add forensic migration archive',
      );
      const result = runChangedFileTypeCheck(repo, emptyTree, headSha);

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain(archivedMigration);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('still rejects a normal-range edit to a baseline-listed unowned file', () => {
    const { headSha: baseSha, repo } = typeCheckBootstrapFixture(['libs/inherited/src/index.ts']);
    try {
      const headSha = commit(
        repo,
        'libs/inherited/src/index.ts',
        'export const inherited = false;\n',
        'edit inherited file',
      );
      const result = runChangedFileTypeCheck(repo, baseSha, headSha);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('changed TypeScript files have no known tsconfig owner');
      expect(result.stderr).toContain('libs/inherited/src/index.ts');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('fails closed when the bootstrap baseline is stale or incomplete', () => {
    const stale = typeCheckBootstrapFixture(['libs/inherited/src/index.ts', 'legacy/missing.ts']);
    const incomplete = typeCheckBootstrapFixture([]);
    try {
      const staleResult = runChangedFileTypeCheck(stale.repo, emptyTree, stale.headSha);
      const incompleteResult = runChangedFileTypeCheck(
        incomplete.repo,
        emptyTree,
        incomplete.headSha,
      );

      expect(staleResult.status).toBe(1);
      expect(staleResult.stderr).toContain('baseline entries are no longer unowned');
      expect(staleResult.stderr).toContain('legacy/missing.ts');
      expect(incompleteResult.status).toBe(1);
      expect(incompleteResult.stderr).toContain('untracked bootstrap ownership debt');
      expect(incompleteResult.stderr).toContain('libs/inherited/src/index.ts');
    } finally {
      rmSync(stale.repo, { recursive: true, force: true });
      rmSync(incomplete.repo, { recursive: true, force: true });
    }
  });
});

describe('first-rollout changed-file lint baseline', () => {
  it('leaves empty-tree validation to full project lint without running the delta linter', () => {
    const repo = fixtureRepository();
    try {
      mkdirSync(join(repo, 'src'), { recursive: true });
      writeFileSync(join(repo, 'src', 'index.ts'), 'export const bootstrap = true;\n');
      const eslint = join(repo, 'fake-eslint.cjs');
      const eslintMarker = join(repo, 'eslint-invoked');
      writeFileSync(
        eslint,
        [
          '#!/usr/bin/env node',
          "const { writeFileSync } = require('node:fs');",
          `writeFileSync(${JSON.stringify(eslintMarker)}, 'invoked');`,
          "const outputIndex = process.argv.indexOf('--output-file');",
          'if (outputIndex < 0) process.exit(2);',
          "writeFileSync(process.argv[outputIndex + 1], '[]');",
          '',
        ].join('\n'),
      );
      chmodSync(eslint, 0o755);
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'bootstrap lint fixture');
      const headSha = git(repo, 'rev-parse', 'HEAD');

      const result = spawnSync(
        process.execPath,
        [
          LINT_CHANGED_FILES,
          '--base',
          '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
          '--head',
          headSha,
        ],
        {
          cwd: repo,
          encoding: 'utf8',
          env: { ...process.env, ESLINT_BIN: eslint },
        },
      );

      expect(result.status).toBe(0);
      expect(existsSync(eslintMarker)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('affected development workflow contract', () => {
  function workflow(path: string): Record<string, unknown> {
    return YAML.parse(readFileSync(join(REPO_ROOT, path), 'utf8')) as Record<string, unknown>;
  }

  function source(path: string): string {
    return readFileSync(join(REPO_ROOT, path), 'utf8');
  }

  it('keeps Full CI off pull requests and branch pushes and gives it a distinct summary', () => {
    const full = workflow('.github/workflows/ci-full.yml') as {
      on?: {
        pull_request?: unknown;
        push?: { branches?: string[]; tags?: string[] };
        schedule?: unknown;
        workflow_dispatch?: unknown;
      };
      jobs?: Record<string, { name?: string }>;
    };

    expect(full.on?.pull_request).toBeUndefined();
    expect(full.on?.push?.branches).toBeUndefined();
    expect(full.on?.push?.tags).toEqual(expect.arrayContaining(['v*', 'release-*']));
    expect(full.on?.schedule).toBeDefined();
    expect(full.on?.workflow_dispatch).toBeDefined();
    expect(full.jobs?.['build-status']).toBeUndefined();
    expect(full.jobs?.['full-ci-status']?.name).toBe('full-ci-status');
  });

  it('uses one immutable SHA range for affected validation and owns build-status', () => {
    const affected = source('.github/workflows/ci-affected.yml');
    const parsedAffected = workflow('.github/workflows/ci-affected.yml') as {
      jobs?: Record<
        string,
        {
          readonly if?: string;
          readonly needs?: string[];
          readonly steps?: Array<{ readonly run?: string }>;
        }
      >;
    };
    const prewarm = source('scripts/ci/prewarm-postgres-testcontainer.ts');
    const requiredChecks = JSON.parse(
      source('.github/manifests/main-required-status-checks.json'),
    ) as {
      workflow_contracts: Array<{
        workflow: string;
        contexts: Array<{ context: string; job_id: string }>;
      }>;
    };

    expect(affected).toContain('scripts/ci/resolve-affected-range.ts');
    expect(affected).toContain('--pr-base-sha "${{ github.event.pull_request.base.sha }}"');
    expect(affected).toContain('--head-sha "${{ github.sha }}"');
    expect(affected).toContain('--development-ref deployed/development');
    expect(affected).toContain(
      'git ls-remote --exit-code --refs origin refs/tags/deployed/development',
    );
    expect(affected).toContain('if [ "$lookup_status" -ne 2 ]; then');
    expect(affected).toContain('name: build-status');
    expect(affected).toContain('uses: ./.github/workflows/build-images.yml');
    expect(affected).toContain('uses: ./.github/workflows/deploy-development.yml');
    expect(affected).not.toContain('uses: ./.github/workflows/deploy-staging.yml');
    expect(affected).not.toContain('uses: ./.github/workflows/deploy-digitalocean.yml');
    expect(affected).not.toContain('dorny/paths-filter');
    expect(affected).not.toContain(
      "git fetch origin '+refs/tags/deployed/development:refs/tags/deployed/development' || true",
    );
    expect(affected).not.toMatch(/origin\//);
    expect(affected).not.toMatch(/npm run (?:lint|test|build):all/);
    expect(prewarm).toMatch(/'--head',\s*head/);
    const imageBuild = parsedAffected.jobs?.['build-development-images'];
    expect(imageBuild?.needs).toContain('build-status');
    expect(imageBuild?.if).toContain("needs.build-status.result == 'success'");
    const buildStatusScript = parsedAffected.jobs?.['build-status']?.steps
      ?.map((step) => step.run ?? '')
      .join('\n');
    for (const job of ['schema-validation', 'sens-enterprise-summary', 'merge-gate']) {
      expect(buildStatusScript).toContain(`"${job}:\${{ needs.${job}.result }}"`);
    }
    expect(
      requiredChecks.workflow_contracts.flatMap((contract) =>
        contract.contexts
          .filter((context) => context.context === 'build-status')
          .map((context) => ({ workflow: contract.workflow, job: context.job_id })),
      ),
    ).toEqual([{ workflow: '.github/workflows/ci-affected.yml', job: 'build-status' }]);
    for (const output of [
      'farm_checks_required',
      'sensor_checks_required',
      'rust_checks_required',
      'dependency_audit_required',
    ]) {
      expect(affected).toContain(`needs.detect-changes.outputs.${output}`);
    }
  });

  it('compares exact range snapshots without commit-only or argv-sized diff expansion', () => {
    const affected = source('.github/workflows/ci-affected.yml');
    const affectedPolicy = source('scripts/ci/affected-target-policy.sh');
    const lintChangedFiles = source('scripts/ci/lint-changed-files.mjs');
    const typeCheckChangedFiles = source('scripts/ci/type-check-changed-files.mjs');

    // The bootstrap baseline is Git's canonical empty tree, not a commit. Two-endpoint
    // diff accepts both the empty tree and ordinary ancestor commits while preserving
    // the exact immutable base/head snapshots selected by the range resolver.
    expect(affectedPolicy).toContain('git diff --name-only "$BASE_REF" "$HEAD_REF" --');
    expect(affectedPolicy).not.toContain('$BASE_REF...$HEAD_REF');
    expect(lintChangedFiles).toMatch(
      /'diff',\s*'--name-status',\s*'--diff-filter=ACMR',\s*options\.base,\s*options\.head/u,
    );
    expect(typeCheckChangedFiles).toMatch(
      /'diff',\s*'--name-only',\s*'--diff-filter=ACMR',\s*options\.base,\s*options\.head/u,
    );
    expect(lintChangedFiles).not.toContain(`${'${options.base}'}...${'${options.head}'}`);
    expect(typeCheckChangedFiles).not.toContain(`${'${options.base}'}...${'${options.head}'}`);

    // A first rollout can contain thousands of paths. Nx owns the immutable range;
    // the workflow must not flatten that file set into one OS-limited argv value.
    expect(affected).toContain(
      'nx show projects --affected --base="$BASE_REF" --head="$HEAD_REF" --with-target=test',
    );
    expect(affected).not.toContain('--files="$FILES_ARG"');
  });

  it('builds only selected immutable images on hosted runners and verifies their digests', () => {
    const build = source('.github/workflows/build-images.yml');
    const parsed = workflow('.github/workflows/build-images.yml') as {
      on?: {
        workflow_call?: { inputs?: Record<string, unknown>; outputs?: Record<string, unknown> };
      };
      jobs?: Record<string, { 'runs-on'?: string; uses?: string }>;
    };

    expect(Object.keys(parsed.on?.workflow_call?.inputs ?? {}).sort()).toEqual([
      'baseline_ref',
      'channel',
      'head_sha',
      'no_cache',
      'requested_services',
    ]);
    expect(Object.keys(parsed.on?.workflow_call?.outputs ?? {})).toEqual(
      expect.arrayContaining([
        'backend_matrix',
        'deploy_services',
        'frontend_matrix',
        'full_deploy',
        'infra_matrix',
        'migration_required',
        'selection_reason',
      ]),
    );
    expect(parsed.on?.workflow_call?.outputs).not.toHaveProperty('image_digest_manifest');
    for (const job of Object.values(parsed.jobs ?? {})) {
      if (!job.uses) expect(job['runs-on']).toBe('ubuntu-latest');
    }
    expect(build).toContain('docker/build-push-action@');
    expect(build).toContain('type=registry');
    expect(build).toContain('${{ inputs.head_sha }}');
    expect(build).not.toContain(':${{ inputs.channel }}-latest');
    expect(build).toContain('docker buildx imagetools inspect');
    expect(build).toContain('Resolve immutable Postgres DR contract digest');
    expect(build).toContain('sha256sum --strict --check "${CONTRACT_MANIFEST}"');
    expect(build).toContain(
      'POSTGRES_DR_CONTRACT_SHA256=${{ steps.postgres_dr_contract.outputs.sha256 }}',
    );
    expect(build).not.toContain('appleboy/ssh-action');
    expect(build).not.toContain('droplet-up.sh');
  });

  it('keeps digest manifests inside the deploy job and fails closed when reusable outputs disappear', () => {
    const affected = source('.github/workflows/ci-affected.yml');
    const build = source('.github/workflows/build-images.yml');
    const deploy = source('.github/workflows/deploy-development.yml');
    const parsedAffected = workflow('.github/workflows/ci-affected.yml') as {
      jobs?: Record<
        string,
        {
          readonly if?: string;
          readonly needs?: string[] | string;
          readonly steps?: Array<{
            readonly env?: Record<string, string>;
            readonly run?: string;
          }>;
          readonly with?: Record<string, unknown>;
        }
      >;
    };
    const parsedDeploy = workflow('.github/workflows/deploy-development.yml') as {
      on?: { workflow_call?: { inputs?: Record<string, unknown> } };
    };

    expect(build).not.toContain('image_digest_manifest:');
    expect(Object.keys(parsedDeploy.on?.workflow_call?.inputs ?? {})).not.toContain(
      'image_digest_manifest',
    );
    expect(affected).not.toContain('outputs.image_digest_manifest');
    expect(parsedAffected.jobs?.['deploy-development']?.with).not.toHaveProperty(
      'image_digest_manifest',
    );
    expect(deploy).not.toContain('inputs.image_digest_manifest');
    expect(deploy).toContain('name: Resolve immutable image digest manifest');
    expect(deploy).toContain('${IMAGE_PREFIX}/${service}:${DEPLOY_SHA}');
    expect(deploy).toContain('echo "DEPLOY_IMAGE_DIGESTS_B64=$manifest" >> "$GITHUB_ENV"');

    const contract = parsedAffected.jobs?.['development-deploy-contract'];
    const contractScript = contract?.steps?.map((step) => step.run ?? '').join('\n') ?? '';
    expect(contract?.if).toContain("needs.build-development-images.result == 'success'");
    expect(contractScript).toContain('Missing deploy_services output');
    expect(contractScript).toContain('Missing image_prefix output');

    const deliveryStatus = parsedAffected.jobs?.['development-delivery-status'];
    const deliveryScript = deliveryStatus?.steps?.map((step) => step.run ?? '').join('\n') ?? '';
    expect(deliveryStatus?.if).toContain("needs.detect-changes.outputs.deploy_changes == 'true'");
    expect(deliveryScript).toContain(
      'build-development-images:${{ needs.build-development-images.result }}',
    );
    expect(deliveryScript).toContain('deploy-development:${{ needs.deploy-development.result }}');

    const manifestResolution = deploy.indexOf('name: Resolve immutable image digest manifest');
    const mutatingSsh = deploy.indexOf('name: Deploy selected images to the development droplet');
    expect(manifestResolution).toBeGreaterThan(0);
    expect(manifestResolution).toBeLessThan(mutatingSsh);
  });

  it('evaluates deploy eligibility after intentionally skipped validation ancestors', () => {
    const affected = workflow('.github/workflows/ci-affected.yml') as {
      jobs?: Record<
        string,
        {
          readonly if?: string;
          readonly needs?: string[] | string;
        }
      >;
    };
    const deploy = affected.jobs?.['deploy-development'];

    expect(deploy?.needs).toEqual(['build-development-images', 'development-deploy-contract']);
    expect(deploy?.if).toContain('always()');
    expect(deploy?.if).toContain("needs.build-development-images.result == 'success'");
    expect(deploy?.if).toContain("needs.development-deploy-contract.result == 'success'");
  });

  it('uses the selected infra matrix for pull-request image builds', () => {
    const affected = source('.github/workflows/ci-affected.yml');

    expect(affected).toContain('infra_matrix: ${{ steps.scope.outputs.infra_matrix }}');
    expect(affected).toContain(
      'include: ${{ fromJson(needs.detect-changes.outputs.infra_matrix) }}',
    );
    expect(affected).toContain('file: ${{ matrix.dockerfile }}');
    expect(affected).toContain('context: ${{ matrix.context }}');
    expect(affected).not.toContain('Build Mosquitto infrastructure image (no push)');
  });

  it('reports validation, hosted image build, and droplet deployment durations separately', () => {
    const affected = source('.github/workflows/ci-affected.yml');
    const build = source('.github/workflows/build-images.yml');
    const deploy = source('.github/workflows/deploy-development.yml');

    expect(build).toContain('image_started_epoch:');
    expect(build).toContain('image_finished_epoch:');
    expect(deploy).toContain('deploy_started_epoch:');
    expect(deploy).toContain('deploy_finished_epoch:');
    expect(affected).toContain('development-timing-summary:');
    expect(affected).toContain('| Affected validation |');
    expect(affected).toContain('| Hosted image build |');
    expect(affected).toContain('| Droplet deployment |');
  });

  it('serializes development deploys, rejects stale main and advances the tag after health success', () => {
    const deploy = source('.github/workflows/deploy-development.yml');
    const parsed = workflow('.github/workflows/deploy-development.yml') as {
      concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
    };

    expect(parsed.concurrency).toEqual({
      group: 'deploy-development',
      'cancel-in-progress': false,
    });
    expect(deploy).toContain('git ls-remote origin refs/heads/main');
    expect(deploy).toContain('RUN_DB_MIGRATE');
    expect(deploy).toContain('scripts/deploy/droplet-up.sh');
    expect(deploy).toContain('deployed/development');
    expect(deploy).toContain('docker buildx imagetools create');
    expect(deploy).toContain(':development-latest');
    expect(deploy).not.toMatch(/docker\s+build(?:\s|$)/);
    expect(deploy).not.toMatch(/nx\s+(?:affected|build|run)/);
    const staleCheck = deploy.indexOf('git ls-remote origin refs/heads/main');
    const firstSsh = deploy.indexOf('appleboy/ssh-action');
    const healthCheckedDeploy = deploy.indexOf('bash scripts/deploy/droplet-up.sh');
    const latestPromotion = deploy.indexOf('docker buildx imagetools create');
    const baselineAdvance = deploy.lastIndexOf('deployed/development');
    expect(staleCheck).toBeGreaterThan(0);
    expect(staleCheck).toBeLessThan(firstSsh);
    expect(healthCheckedDeploy).toBeLessThan(latestPromotion);
    expect(latestPromotion).toBeLessThan(baselineAdvance);
  });

  it('keeps package publishing permission on the deploy job, not the preflight default', () => {
    const development = workflow('.github/workflows/deploy-development.yml') as {
      permissions?: Record<string, string>;
      jobs?: Record<string, { permissions?: Record<string, string> }>;
    };

    expect(development.permissions).toEqual({ contents: 'read' });
    expect(development.jobs?.['capacity-preflight']?.permissions).toBeUndefined();
    expect(development.jobs?.deploy?.permissions).toEqual({
      contents: 'write',
      packages: 'write',
    });
  });

  it('allows migration skipping only for catalog-proven frontend-only development deploys', () => {
    const deploy = source('.github/workflows/deploy-development.yml');
    const droplet = source('scripts/deploy/droplet-up.sh');
    const signals = source('scripts/deploy/assert-service-signals.ts');
    const production = source('.github/workflows/deploy-digitalocean.yml');

    expect(deploy).toContain('RUN_DB_MIGRATE: ${{ inputs.migration_required }}');
    expect(droplet).toContain('RUN_DB_MIGRATE="${RUN_DB_MIGRATE:-true}"');
    expect(droplet).toContain('validate_migration_policy');
    expect(droplet).toContain('CATALOG_FRONTEND_IMAGE_SERVICES');
    expect(droplet).toContain(
      'RUN_DB_MIGRATE=false is restricted to selective development deploys',
    );
    expect(droplet).toContain(
      'RUN_DB_MIGRATE=false requires a catalog-proven frontend-only service set',
    );
    expect(droplet).toContain('MIGRATIONS_APPLIED_THIS_RELEASE=0');
    expect(droplet).toContain('CATALOG_GATEWAY_RECOMPOSITION_SERVICES');
    expect(droplet).not.toContain('BACKEND_PATTERN=');
    expect(droplet).toMatch(
      /if \[ "\$RUN_DB_MIGRATE" = "true" \]; then\s+if \[ "\$\{PRESERVE_DATA_INFRASTRUCTURE\}" = "true" \]; then\s+echo "=== Proving preserved migration infrastructure is healthy ==="\s+assert_preserved_migration_infrastructure\s+else\s+echo "=== Ensuring migration infrastructure is running ==="/,
    );
    expect(droplet).toMatch(
      /if \[ "\$RUN_DB_MIGRATE" = "true" \]; then\s+run_db_migrate_or_exit "selective deploy"/,
    );
    expect(signals).toContain(
      "const migrationRequired = process.env['RUN_DB_MIGRATE'] !== 'false';",
    );
    expect(signals).toMatch(
      /new Set<string>\(\s*migrationRequired \? \['db-migrate', \.\.\.deployServices\] : deployServices,?\s*\)/,
    );
    expect(production).not.toContain('RUN_DB_MIGRATE:');
  });

  it('separates a full development image rollout from persistent infrastructure mutation', () => {
    const development = source('.github/workflows/deploy-development.yml');
    const production = source('.github/workflows/deploy-digitalocean.yml');
    const droplet = source('scripts/deploy/droplet-up.sh');

    expect(development).toContain("PRESERVE_DATA_INFRASTRUCTURE: 'true'");
    expect(development).toContain(
      'envs: DEPLOY_IMAGE_DIGESTS_B64,DEPLOY_MODE,DEPLOY_SERVICES,DEPLOY_SHA,FULL_DEPLOY,GHCR_ACTOR,GHCR_TOKEN,IMAGE_PREFIX,PRESERVE_DATA_INFRASTRUCTURE,RUN_DB_MIGRATE,TAG,DEPLOY_CHECKOUT_DIR',
    );
    expect(production).not.toContain('PRESERVE_DATA_INFRASTRUCTURE:');

    expect(droplet).toContain('source scripts/deploy/lib/deployment-mode-policy.sh');
    expect(droplet).toContain(
      'INFRA_IMAGE_SERVICES="${CATALOG_INFRA_IMAGE_SERVICES:?generated infra image services missing}"',
    );
    expect(droplet).toContain('validate_data_infrastructure_policy');
    expect(droplet).toContain('configure_preserved_compose_interpolation');
    expect(droplet).toContain('if deploy_uses_full_stack_path; then');
    expect(droplet).toContain('assert_preserved_migration_infrastructure');
    expect(droplet).toMatch(
      /docker compose -f docker-compose\.droplet\.yml \\\n+\s+up --no-deps --no-build --abort-on-container-exit \\\n+\s+--exit-code-from db-migrate db-migrate/,
    );
    expect(droplet).toContain('done < <(rollout_image_services)');
  });

  it('makes production backend dependency trees self-contained before image publication', () => {
    const activeDockerfiles = [
      'infrastructure/docker/Dockerfile.backend.simple',
      'infrastructure/docker/Dockerfile.db-migrate',
    ];

    for (const dockerfilePath of activeDockerfiles) {
      const dockerfile = source(dockerfilePath);
      const vendorCopy = dockerfile.indexOf(
        'COPY --chown=nestjs:nodejs tools/vendor/apollo-playground-disabled ./tools/vendor/apollo-playground-disabled',
      );
      const dependencyInstall = dockerfile.indexOf('npm ci --omit=dev');

      expect(vendorCopy).toBeGreaterThan(0);
      expect(vendorCopy).toBeLessThan(dependencyInstall);
      expect(dockerfile).toContain('npm ls --omit=dev --all');
      expect(dockerfile).toContain(
        'node -e "require(\'@apollo/server-plugin-landing-page-graphql-playground\')"',
      );
    }
  });

  it('handles compose startup failure inside the deployment rollback boundary', () => {
    const droplet = source('scripts/deploy/droplet-up.sh');

    expect(droplet).toContain(
      'if ! docker compose -f docker-compose.droplet.yml up -d --no-build 2>&1; then',
    );
    expect(droplet).toContain(
      'if ! docker compose -f docker-compose.droplet.yml up -d --no-deps --no-build --force-recreate ${RESTART_SERVICES} 2>&1; then',
    );
    expect(droplet).toContain('record_release_ledger "failed" "service_recreate"');
    expect(droplet).toContain('rollback_and_record "service_recreate" || true');
  });

  it('leaves the production stop-line enabled in its dedicated workflow', () => {
    const production = source('.github/workflows/deploy-digitalocean.yml');

    expect(production).toContain(
      'PRODUCTION_DEPLOY_ENABLED: ${{ vars.PRODUCTION_DEPLOY_ENABLED }}',
    );
    expect(production).toContain('if [ "${PRODUCTION_DEPLOY_ENABLED}" = "true" ]');
    expect(production).toContain('Production deployment is locked');
  });
});
