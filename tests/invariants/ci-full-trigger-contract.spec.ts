import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as YAML from 'yaml';

import {
  SOURCE_CONTROL_LEAF_CATALOG_V1,
  SOURCE_INVENTORY_STATIC_CI_JOB_V1,
  assertSourceControlLeafCatalogTopologyV1,
  canonicalSourceControlLeafCatalogBytesV1,
  parseCanonicalSourceControlLeafCatalogBytesV1,
  parseSourceControlLeafCatalogV1,
  type SourceControlYamlSurfaceV1,
} from '../../tools/gates/lib/source-control-leaf-catalog';
import SERVICE_COVERAGE_BASELINES from '../../tools/quality/service-coverage-baselines.js';

interface Workflow {
  on?: {
    push?: {
      branches?: string[];
      tags?: string[];
    };
    pull_request?: {
      branches?: string[];
    };
  };
  concurrency?: {
    group?: string;
    'cancel-in-progress'?: string | boolean;
  };
  jobs?: Record<
    string,
    {
      name?: string;
      needs?: string[];
      if?: string;
      permissions?: Record<string, string>;
      steps?: Array<{
        name?: string;
        uses?: string;
        run?: string;
        with?: Record<string, string | boolean | number>;
        env?: Record<string, string>;
      }>;
    }
  >;
}

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'ci-full.yml');
const QUALITY_WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'quality-gates.yml');
const ROOT_PACKAGE_PATH = path.join(REPO_ROOT, 'package.json');
const SOURCE_CONTROL_LEAF_CATALOG_PATH = path.join(
  REPO_ROOT,
  'tools',
  'quality',
  'source-control-leaf-catalog.v1.json',
);
const ROOT_LOCK_PATH = path.join(REPO_ROOT, 'package-lock.json');
const CHANGED_TYPE_CHECK_PATH = path.join(
  REPO_ROOT,
  'scripts',
  'ci',
  'type-check-changed-files.mjs',
);
const SERVICE_COVERAGE_CONFIGS = {
  'admin-api-service': 'apps/admin-api-service/jest.config.ts',
  'auth-service': 'apps/auth-service/jest.config.ts',
  'billing-service': 'apps/billing-service/jest.config.ts',
  'farm-service': 'apps/farm-service/jest.config.ts',
  'hr-service': 'apps/hr-service/jest.config.ts',
  'sensor-service': 'apps/sensor-service/jest.config.ts',
} as const;

function readWorkflow(workflowPath = WORKFLOW_PATH): Workflow {
  return YAML.parse(fs.readFileSync(workflowPath, 'utf8')) as Workflow;
}

function ownersOfCommand(workflow: Workflow, command: string): string[] {
  return Object.entries(workflow.jobs ?? {})
    .filter(([, definition]) =>
      (definition.steps ?? []).some((candidate) => candidate.run === command),
    )
    .map(([jobId]) => jobId)
    .sort();
}

function listYamlFiles(directory: string): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory()
        ? listYamlFiles(absolute)
        : /\.ya?ml$/.test(entry.name)
          ? [absolute]
          : [];
    })
    .sort();
}

function readSourceControlYamlSurfaces(): SourceControlYamlSurfaceV1[] {
  return [
    ...listYamlFiles(path.join(REPO_ROOT, '.github', 'workflows')).map(
      (absolute): SourceControlYamlSurfaceV1 => ({
        kind: 'WORKFLOW',
        path: path.relative(REPO_ROOT, absolute).split(path.sep).join('/'),
        document: YAML.parse(fs.readFileSync(absolute, 'utf8')) as unknown,
      }),
    ),
    ...listYamlFiles(path.join(REPO_ROOT, '.github', 'actions')).map(
      (absolute): SourceControlYamlSurfaceV1 => ({
        kind: 'ACTION',
        path: path.relative(REPO_ROOT, absolute).split(path.sep).join('/'),
        document: YAML.parse(fs.readFileSync(absolute, 'utf8')) as unknown,
      }),
    ),
  ];
}

function readRootPackageScripts(): Readonly<Record<string, string>> {
  const document = JSON.parse(fs.readFileSync(ROOT_PACKAGE_PATH, 'utf8')) as {
    scripts?: Record<string, unknown>;
  };
  if (!document.scripts) {
    throw new Error('package.json scripts authority is unavailable');
  }
  const scripts: Record<string, string> = {};
  for (const [name, command] of Object.entries(document.scripts)) {
    if (typeof command !== 'string' || command.length === 0) {
      throw new Error(`package.json script ${name} is not one command string`);
    }
    scripts[name] = command;
  }
  return scripts;
}

interface RawSourceControlLeafCatalogFixture {
  bootstrap_action: Record<string, unknown> & {
    inputs: Record<string, unknown>;
    steps: Array<Record<string, unknown>>;
    with: Record<string, unknown>;
  };
  checkout_profile: Record<string, unknown> & {
    with: Record<string, unknown>;
  };
  leaf_jobs: Array<
    Record<string, unknown> & {
      commands: Array<Record<string, unknown>>;
      execution_identity: Record<string, unknown>;
    }
  >;
  workflow_closure: Array<{
    path: string;
    permissions: Record<string, unknown>;
  }>;
}

function readRawSourceControlLeafCatalog(): RawSourceControlLeafCatalogFixture {
  return JSON.parse(
    fs.readFileSync(SOURCE_CONTROL_LEAF_CATALOG_PATH, 'utf8'),
  ) as RawSourceControlLeafCatalogFixture;
}

function rawLeafJob(
  catalog: RawSourceControlLeafCatalogFixture,
  role: string,
): RawSourceControlLeafCatalogFixture['leaf_jobs'][number] {
  const job = catalog.leaf_jobs.find((candidate) => candidate.role === role);
  if (!job) {
    throw new Error(`raw source-control catalog lost role ${role}`);
  }
  return job;
}

describe('CI Full protected-main and PR contract', () => {
  it('runs for pull requests and pushes to main while retaining release tags', () => {
    const workflow = readWorkflow();

    expect(workflow.on?.pull_request?.branches).toContain('main');
    expect(workflow.on?.push?.branches).toContain('main');
    expect(workflow.on?.push?.tags).toEqual(expect.arrayContaining(['v*', 'release-*']));
  });

  it('cancels superseded PR runs but gives every non-PR SHA an independent group', () => {
    const workflow = readWorkflow();

    expect(workflow.concurrency?.group).toBe(
      '${{ github.workflow }}-${{ github.event.pull_request.number || github.sha }}',
    );
    expect(workflow.concurrency?.['cancel-in-progress']).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );
  });

  it('uses build-status as the canonical summary of every full-CI job', () => {
    const workflow = readWorkflow();
    const jobs = workflow.jobs ?? {};
    const summary = jobs['build-status'];
    const expectedDependencies = Object.keys(jobs)
      .filter((jobId) => jobId !== 'build-status')
      .sort();

    expect(summary?.name).toBe('build-status');
    expect(summary?.if).toBe('always()');
    expect([...(summary?.needs ?? [])].sort()).toEqual(expectedDependencies);

    const summaryScript = summary?.steps?.map((step) => step.run ?? '').join('\n') ?? '';
    for (const dependency of expectedDependencies) {
      expect(summaryScript).toContain(`needs.${dependency}.result`);
    }
  });

  it('removes checkout credentials from every full-CI job', () => {
    const jobs = readWorkflow().jobs ?? {};
    const checkouts = Object.entries(jobs).flatMap(([job, definition]) =>
      (definition.steps ?? [])
        .filter((step) => step.uses?.startsWith('actions/checkout@'))
        .map((step) => ({ job, step })),
    );

    expect(checkouts.length).toBeGreaterThan(0);
    for (const { job, step } of checkouts) {
      expect({ job, persistCredentials: step.with?.['persist-credentials'] }).toEqual({
        job,
        persistCredentials: false,
      });
    }
  });

  it('compiles every source-control leaf from one closed versioned catalog', () => {
    expect(SOURCE_INVENTORY_STATIC_CI_JOB_V1).toBe('source-inventory-static');
    expect(() =>
      assertSourceControlLeafCatalogTopologyV1(
        SOURCE_CONTROL_LEAF_CATALOG_V1,
        readSourceControlYamlSurfaces(),
      ),
    ).not.toThrow();
  });

  it('requires canonical catalog bytes and recursively freezes the compiled authority', () => {
    const bytes = fs.readFileSync(SOURCE_CONTROL_LEAF_CATALOG_PATH, 'utf8');
    const parsedRaw: unknown = JSON.parse(bytes);

    expect(bytes).not.toContain('repository_mutation');
    expect(bytes).not.toContain('remote_network');
    expect(canonicalSourceControlLeafCatalogBytesV1(parsedRaw)).toBe(bytes);
    const compiled = parseCanonicalSourceControlLeafCatalogBytesV1(bytes);
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.checkoutProfile.with)).toBe(true);
    expect(Object.isFrozen(compiled.leafJobs)).toBe(true);
    expect(Object.isFrozen(compiled.leafJobs[0]?.commands)).toBe(true);
    expect(Reflect.set(compiled.leafJobs[0] ?? {}, 'job', 'tampered')).toBe(false);

    expect(() => parseCanonicalSourceControlLeafCatalogBytesV1(`${bytes}\n`)).toThrow(
      /bytes must be canonical sorted JSON/,
    );
    const duplicateSchema = bytes.replace(
      '  "schema": "SourceControlLeafCatalogV1",',
      '  "schema": "SourceControlLeafCatalogV1",\n  "schema": "SourceControlLeafCatalogV1",',
    );
    expect(duplicateSchema).not.toBe(bytes);
    expect(() => parseCanonicalSourceControlLeafCatalogBytesV1(duplicateSchema)).toThrow(
      /bytes must be canonical sorted JSON/,
    );
  });

  it('requires the complete role set and each role credential/command contract', () => {
    const missingRole = readRawSourceControlLeafCatalog();
    missingRole.leaf_jobs.pop();
    expect(() => parseSourceControlLeafCatalogV1(missingRole)).toThrow(/required role set/);

    const duplicateRole = readRawSourceControlLeafCatalog();
    const firstRole = duplicateRole.leaf_jobs[0]?.role;
    const lastJob = duplicateRole.leaf_jobs.at(-1);
    if (typeof firstRole !== 'string' || !lastJob) {
      throw new Error('raw source-control catalog role fixtures are unavailable');
    }
    lastJob.role = firstRole;
    expect(() => parseSourceControlLeafCatalogV1(duplicateRole)).toThrow(/required role set/);

    const wrongStaticIdentity = readRawSourceControlLeafCatalog();
    rawLeafJob(wrongStaticIdentity, 'SOURCE_INVENTORY_STATIC_CI_V1').execution_identity = {
      kind: 'GITHUB_READ_TOKEN_V1',
      command_env: { GITHUB_TOKEN: '${{ github.token }}' },
      permissions: {
        actions: 'read',
        checks: 'read',
        contents: 'read',
        'pull-requests': 'read',
      },
    };
    expect(() => parseSourceControlLeafCatalogV1(wrongStaticIdentity)).toThrow(
      /execution identity must be NO_COMMAND_CREDENTIALS_V1/,
    );

    const credentialFieldOnStatic = readRawSourceControlLeafCatalog();
    rawLeafJob(
      credentialFieldOnStatic,
      'SOURCE_INVENTORY_STATIC_CI_V1',
    ).execution_identity.command_env = { GITHUB_TOKEN: '${{ github.token }}' };
    expect(() => parseSourceControlLeafCatalogV1(credentialFieldOnStatic)).toThrow(
      /keys must be exactly kind/,
    );

    const extraEvidenceCommand = readRawSourceControlLeafCatalog();
    rawLeafJob(extraEvidenceCommand, 'CAPABILITY_INTEGRATION_EVIDENCE_V1').commands.push({
      id: 'UNDECLARED_EXTRA_COMMAND_V1',
      name: 'Undeclared extra command',
      npm_script: 'test:undeclared-extra-command',
    });
    expect(() => parseSourceControlLeafCatalogV1(extraEvidenceCommand)).toThrow(
      /must own exactly 1 command/,
    );

    const writableEvidence = readRawSourceControlLeafCatalog();
    const writableIdentity = rawLeafJob(
      writableEvidence,
      'CAPABILITY_INTEGRATION_EVIDENCE_V1',
    ).execution_identity;
    writableIdentity.permissions = {
      actions: 'write',
      checks: 'read',
      contents: 'read',
      'pull-requests': 'read',
    };
    expect(() => parseSourceControlLeafCatalogV1(writableEvidence)).toThrow(
      /exact GitHub read-token grant set/,
    );

    const wrongTokenEnv = readRawSourceControlLeafCatalog();
    rawLeafJob(wrongTokenEnv, 'CAPABILITY_INTEGRATION_EVIDENCE_V1').execution_identity.command_env =
      { GITHUB_TOKEN: '${{ secrets.OTHER_TOKEN }}' };
    expect(() => parseSourceControlLeafCatalogV1(wrongTokenEnv)).toThrow(
      /exact GitHub Actions read token/,
    );

    const expandedWorkflowGrant = readRawSourceControlLeafCatalog();
    const workflow = expandedWorkflowGrant.workflow_closure[0];
    if (!workflow) {
      throw new Error('raw source-control workflow closure is unavailable');
    }
    workflow.permissions.issues = 'read';
    expect(() => parseSourceControlLeafCatalogV1(expandedWorkflowGrant)).toThrow(
      /exact workflow read-only grant set/,
    );
  });

  it('enforces the EVENT_HEAD_V1 runner, checkout identity, and exact checkout inputs', () => {
    const mutations: Array<(catalog: RawSourceControlLeafCatalogFixture) => void> = [
      (catalog) => {
        catalog.checkout_profile.kind = 'BRANCH_NAME_V1';
      },
      (catalog) => {
        catalog.checkout_profile.runner = 'self-hosted';
      },
      (catalog) => {
        catalog.checkout_profile.uses = 'actions/checkout@main';
      },
      (catalog) => {
        catalog.checkout_profile.with.ref = '${{ github.ref }}';
      },
      (catalog) => {
        catalog.checkout_profile.with['fetch-depth'] = 1;
      },
      (catalog) => {
        catalog.checkout_profile.with['persist-credentials'] = true;
      },
      (catalog) => {
        catalog.checkout_profile.with.token = '${{ github.token }}';
      },
      (catalog) => {
        catalog.leaf_jobs[0] = {
          ...catalog.leaf_jobs[0],
          runs_on: 'self-hosted',
        } as RawSourceControlLeafCatalogFixture['leaf_jobs'][number];
      },
    ];

    for (const mutate of mutations) {
      const catalog = readRawSourceControlLeafCatalog();
      mutate(catalog);
      expect(() => parseSourceControlLeafCatalogV1(catalog)).toThrow();
    }
  });

  it('binds the bootstrap path, caller inputs, and immutable pinned two-step profile', () => {
    const mutations: Array<(catalog: RawSourceControlLeafCatalogFixture) => void> = [
      (catalog) => {
        catalog.bootstrap_action.uses = './.github/actions/another-action';
      },
      (catalog) => {
        catalog.bootstrap_action.with.extra = 'value';
      },
      (catalog) => {
        catalog.bootstrap_action.inputs.extra = { required: true };
      },
      (catalog) => {
        catalog.bootstrap_action.steps.push({ name: 'Extra', shell: 'bash', run: 'true' });
      },
      (catalog) => {
        const setup = catalog.bootstrap_action.steps[0];
        if (setup) setup.uses = 'actions/setup-node@main';
      },
      (catalog) => {
        const install = catalog.bootstrap_action.steps[1];
        if (install) install.run = 'npm ci --ignore-scripts --no-audit --prefer-offline';
      },
    ];

    for (const mutate of mutations) {
      const catalog = readRawSourceControlLeafCatalog();
      mutate(catalog);
      expect(() => parseSourceControlLeafCatalogV1(catalog)).toThrow();
    }
  });

  it('rejects duplicate command owners hidden in workflows or composite shell commands', () => {
    const command = SOURCE_CONTROL_LEAF_CATALOG_V1.leafJobs[0]?.commands[0]?.run;
    if (!command) {
      throw new Error('source-control catalog lost its first command');
    }
    const surfaces = readSourceControlYamlSurfaces();
    const workflowDuplicate: SourceControlYamlSurfaceV1 = {
      kind: 'WORKFLOW',
      path: '.github/workflows/adversarial-duplicate.yml',
      document: {
        jobs: {
          duplicate: {
            steps: [{ run: `echo before && ${command} && echo after` }],
          },
        },
      },
    };
    const actionDuplicate: SourceControlYamlSurfaceV1 = {
      kind: 'ACTION',
      path: '.github/actions/adversarial-duplicate/action.yml',
      document: {
        runs: {
          using: 'composite',
          steps: [{ shell: 'bash', run: `(${command}) || true` }],
        },
      },
    };

    expect(() =>
      assertSourceControlLeafCatalogTopologyV1(SOURCE_CONTROL_LEAF_CATALOG_V1, [
        ...surfaces,
        workflowDuplicate,
      ]),
    ).toThrow(/must have one atomic owner/);
    expect(() =>
      assertSourceControlLeafCatalogTopologyV1(SOURCE_CONTROL_LEAF_CATALOG_V1, [
        ...surfaces,
        actionDuplicate,
      ]),
    ).toThrow(/must have one atomic owner/);
  });

  it('rejects ungoverned workflow steps and composite-action step drift', () => {
    const surfaces = readSourceControlYamlSurfaces();
    const workflowPath = SOURCE_CONTROL_LEAF_CATALOG_V1.workflowClosure[0]?.path;
    const actionPath = SOURCE_CONTROL_LEAF_CATALOG_V1.bootstrapAction.path;
    if (!workflowPath) {
      throw new Error('source-control catalog lost its workflow closure');
    }
    const workflowDrift = surfaces.map((surface) =>
      surface.path === workflowPath
        ? {
            ...surface,
            document: {
              ...(surface.document as Record<string, unknown>),
              jobs: {
                ...((surface.document as Record<string, unknown>).jobs as Record<string, unknown>),
                [SOURCE_INVENTORY_STATIC_CI_JOB_V1]: {
                  ...((
                    (surface.document as Record<string, unknown>).jobs as Record<
                      string,
                      Record<string, unknown>
                    >
                  )[SOURCE_INVENTORY_STATIC_CI_JOB_V1] ?? {}),
                  steps: [
                    ...((
                      (surface.document as Record<string, unknown>).jobs as Record<
                        string,
                        { steps?: unknown[] }
                      >
                    )[SOURCE_INVENTORY_STATIC_CI_JOB_V1]?.steps ?? []),
                    { name: 'Ungoverned', run: 'echo ungoverned' },
                  ],
                },
              },
            },
          }
        : surface,
    );
    const actionDrift = surfaces.map((surface) =>
      surface.path === actionPath
        ? {
            ...surface,
            document: {
              ...(surface.document as Record<string, unknown>),
              runs: {
                ...((surface.document as Record<string, unknown>).runs as Record<string, unknown>),
                steps: [
                  ...((
                    (surface.document as Record<string, unknown>).runs as {
                      steps?: unknown[];
                    }
                  ).steps ?? []),
                  { name: 'Ungoverned', shell: 'bash', run: 'echo ungoverned' },
                ],
              },
            },
          }
        : surface,
    );

    expect(() =>
      assertSourceControlLeafCatalogTopologyV1(SOURCE_CONTROL_LEAF_CATALOG_V1, workflowDrift),
    ).toThrow(/differs from catalog/);
    expect(() =>
      assertSourceControlLeafCatalogTopologyV1(SOURCE_CONTROL_LEAF_CATALOG_V1, actionDrift),
    ).toThrow(/runs projection differs/);
  });

  it('requires exact package scripts without implicit npm pre/post hooks', () => {
    const command = SOURCE_CONTROL_LEAF_CATALOG_V1.leafJobs[0]?.commands[0];
    if (!command) {
      throw new Error('source-control catalog lost its first command');
    }
    const surfaces = readSourceControlYamlSurfaces();
    const packageScripts = readRootPackageScripts();

    expect(() =>
      assertSourceControlLeafCatalogTopologyV1(SOURCE_CONTROL_LEAF_CATALOG_V1, surfaces, {
        ...packageScripts,
        [`pre${command.npmScript}`]: 'node pre-hook.js',
      }),
    ).toThrow(/must not acquire implicit npm hook/);
    expect(() =>
      assertSourceControlLeafCatalogTopologyV1(SOURCE_CONTROL_LEAF_CATALOG_V1, surfaces, {
        ...packageScripts,
        [`post${command.npmScript}`]: 'node post-hook.js',
      }),
    ).toThrow(/must not acquire implicit npm hook/);
    const withoutCommand = Object.fromEntries(
      Object.entries(packageScripts).filter(([name]) => name !== command.npmScript),
    );
    expect(() =>
      assertSourceControlLeafCatalogTopologyV1(
        SOURCE_CONTROL_LEAF_CATALOG_V1,
        surfaces,
        withoutCommand,
      ),
    ).toThrow(/references missing npm script/);
  });

  it('keeps composition gates on the PR merge ref and assigns invariants by branch', () => {
    const full = readWorkflow();
    const quality = readWorkflow(QUALITY_WORKFLOW_PATH);

    for (const jobId of ['invariants-fast', 'deploy-ssot-gates']) {
      const checkout = full.jobs?.[jobId]?.steps?.find((step) =>
        step.uses?.startsWith('actions/checkout@'),
      );
      expect(checkout?.with).toEqual({
        'fetch-depth': 0,
        'persist-credentials': false,
      });
    }

    expect(ownersOfCommand(full, 'npm run invariants:fast')).toEqual(['invariants-fast']);
    expect(ownersOfCommand(quality, 'npm run invariants:fast')).toEqual(['invariants-fast']);
    expect(full.jobs?.['invariants-fast']?.if).toBeUndefined();
    expect(quality.jobs?.['invariants-fast']?.if).toBe(
      "github.base_ref == 'develop' || github.ref == 'refs/heads/develop'",
    );
    expect(full.jobs?.['build-status']?.needs).toContain('invariants-fast');
  });

  it('installs the pinned Rust toolchain before every parallel full-surface command', () => {
    const jobsAndCommands = {
      'lint-and-typecheck': 'npm run lint:all -- --max-warnings=0',
      test: 'npm run test:all -- --coverage',
      build: 'npm run build:all',
    };

    for (const [jobId, command] of Object.entries(jobsAndCommands)) {
      const steps = readWorkflow().jobs?.[jobId]?.steps ?? [];
      const toolchainIndex = steps.findIndex(
        (step) => step.uses === './.github/actions/setup-rust-workspace',
      );
      const commandIndex = steps.findIndex((step) => step.run?.includes(command));

      expect(toolchainIndex).toBeGreaterThan(-1);
      expect(commandIndex).toBeGreaterThan(-1);
      expect(toolchainIndex).toBeLessThan(commandIndex);
    }
  });

  it('ratchets formatting against the PR or push base instead of historical debt', () => {
    const steps = readWorkflow().jobs?.['lint-and-typecheck']?.steps ?? [];
    const format = steps.find((step) => step.name === 'Check formatting of changed files');

    expect(format?.run).toBe('node tools/quality/quality.mjs format check-changed');
    expect(format?.env).toEqual({
      FORMAT_BASE_SHA: '${{ github.event.pull_request.base.sha || github.event.before }}',
    });
    expect(steps.some((step) => step.run === 'npm run format:check')).toBe(false);
  });

  it('installs the Vitest coverage provider at the exact root runner version', () => {
    const packageJson = JSON.parse(fs.readFileSync(ROOT_PACKAGE_PATH, 'utf8')) as {
      devDependencies?: Record<string, string>;
    };
    const packageLock = JSON.parse(fs.readFileSync(ROOT_LOCK_PATH, 'utf8')) as {
      packages?: Record<
        string,
        {
          version?: string;
          devDependencies?: Record<string, string>;
          peerDependencies?: Record<string, string>;
        }
      >;
    };
    const rootVitest = packageJson.devDependencies?.vitest;
    const rootCoverage = packageJson.devDependencies?.['@vitest/coverage-v8'];

    expect(rootVitest).toBe('3.2.4');
    expect(rootCoverage).toBe(rootVitest);
    expect(packageLock.packages?.['']?.devDependencies?.['@vitest/coverage-v8']).toBe(rootVitest);
    expect(packageLock.packages?.['node_modules/@vitest/coverage-v8']?.version).toBe(rootVitest);
    expect(
      packageLock.packages?.['node_modules/@vitest/coverage-v8']?.peerDependencies?.vitest,
    ).toBe(rootVitest);
  });

  it('routes test utility directories through their project test compiler', () => {
    const guard = fs.readFileSync(CHANGED_TYPE_CHECK_PATH, 'utf8');

    expect(guard).toContain('/(?:^|\\/)test-utils\\//.test(file)');
  });

  it('rejects a changed-typecheck scratch root contained by the repository', () => {
    const result = spawnSync(
      process.execPath,
      [CHANGED_TYPE_CHECK_PATH, '--base', 'HEAD', '--head', 'HEAD'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          TEMP: REPO_ROOT,
          TMP: REPO_ROOT,
          TMPDIR: REPO_ROOT,
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refusing scratch root inside repository');
  });

  it('ratchets every previously dormant Jest coverage floor from its first full-CI baseline', () => {
    expect(SERVICE_COVERAGE_BASELINES).toEqual({
      'admin-api-service': {
        branches: 14.17,
        functions: 18.16,
        lines: 27.27,
        statements: 27.43,
      },
      'auth-service': {
        branches: 42.41,
        functions: 22.67,
        lines: 48.18,
        statements: 48.56,
      },
      'billing-service': {
        branches: 47.09,
        functions: 33.37,
        lines: 53.33,
        statements: 53.05,
      },
      'farm-service': {
        branches: 32.86,
        functions: 20.39,
        lines: 33.92,
        statements: 33.84,
      },
      'hr-service': {
        branches: 30.3,
        functions: 15.62,
        lines: 34.29,
        statements: 34.66,
      },
      'sensor-service': {
        branches: 19.22,
        functions: 14.92,
        lines: 38.64,
        statements: 39.85,
      },
    });

    for (const service of Object.keys(SERVICE_COVERAGE_CONFIGS) as Array<
      keyof typeof SERVICE_COVERAGE_CONFIGS
    >) {
      const configPath = SERVICE_COVERAGE_CONFIGS[service];
      const config = fs.readFileSync(path.join(REPO_ROOT, configPath), 'utf8');

      expect(config).toContain(`coverageBaselines['${service}']`);
      expect(Object.values(SERVICE_COVERAGE_BASELINES[service]).every((floor) => floor > 0)).toBe(
        true,
      );
    }
  });

  it('verifies and retains repository-owned coverage evidence with minimum authority', () => {
    const testJob = readWorkflow().jobs?.test;
    const steps = testJob?.steps ?? [];
    const verifyIndex = steps.findIndex((step) => step.name === 'Verify coverage evidence');
    const uploadIndex = steps.findIndex((step) => step.name === 'Upload coverage evidence');
    const upload = steps[uploadIndex];

    expect(testJob?.permissions).toEqual({
      contents: 'read',
    });
    expect(verifyIndex).toBeGreaterThan(-1);
    expect(uploadIndex).toBeGreaterThan(verifyIndex);
    expect(steps[verifyIndex]?.run).toBe('node tools/quality/coverage-evidence.js');
    expect(upload?.uses).toBe('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a');
    expect(upload?.with).toEqual({
      name: 'coverage-${{ github.sha }}',
      path:
        'coverage/coverage-evidence.json\n' +
        'coverage/**/lcov.info\n' +
        'libs/aquaculture-engines/coverage/lcov.info\n' +
        'mcp/**/coverage/lcov.info\n' +
        'web/**/coverage/lcov.info\n',
      'if-no-files-found': 'error',
      'retention-days': 30,
    });
    expect(steps.some((step) => step.uses?.startsWith('codecov/'))).toBe(false);
  });

  it('keeps non-unit and archived sources outside full-CI coverage collection', () => {
    const farmConfig = fs.readFileSync(
      path.join(REPO_ROOT, SERVICE_COVERAGE_CONFIGS['farm-service']),
      'utf8',
    );
    const hrConfig = fs.readFileSync(
      path.join(REPO_ROOT, SERVICE_COVERAGE_CONFIGS['hr-service']),
      'utf8',
    );

    expect(farmConfig).toContain("'<rootDir>/src/__tests__/e2e/'");
    expect(farmConfig).toContain("'<rootDir>/test/'");
    expect(hrConfig).toContain("'<rootDir>/src/database/migrations/.archive/'");
  });
});
