import * as fs from 'node:fs';
import * as path from 'node:path';

import * as YAML from 'yaml';

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
const ROOT_PACKAGE_PATH = path.join(REPO_ROOT, 'package.json');
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

function readWorkflow(): Workflow {
  return YAML.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8')) as Workflow;
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

  it('installs the pinned Rust toolchain before every parallel full-surface command', () => {
    const jobsAndCommands = {
      'lint-and-typecheck': 'npm run lint:all -- --max-warnings=0',
      test: 'npm run test:all -- --coverage',
      build: 'npm run build:all',
    };

    for (const [jobId, command] of Object.entries(jobsAndCommands)) {
      const steps = readWorkflow().jobs?.[jobId]?.steps ?? [];
      const toolchainIndex = steps.findIndex(
        (step) => step.uses === 'dtolnay/rust-toolchain@67ef31d5b988238dd797d409d6f9574278e20537',
      );
      const commandIndex = steps.findIndex((step) => step.run?.includes(command));
      const toolchain = steps[toolchainIndex];

      expect(toolchainIndex).toBeGreaterThan(-1);
      expect(commandIndex).toBeGreaterThan(-1);
      expect(toolchainIndex).toBeLessThan(commandIndex);
      expect(toolchain?.with).toEqual({
        toolchain: '1.88.0',
        components: 'rustfmt,clippy,rust-src',
        targets: 'x86_64-unknown-linux-musl,aarch64-unknown-linux-musl',
      });
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
