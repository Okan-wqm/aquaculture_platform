import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

import * as YAML from 'yaml';

const REPO_ROOT = process.cwd();
const RUST_SETUP_ACTION = './.github/actions/setup-rust-workspace';
const RUST_FANOUT_WORKFLOWS = [
  '.github/workflows/ci-affected.yml',
  '.github/workflows/ci-full.yml',
  '.github/workflows/performance-benchmark.yml',
] as const;

interface WorkflowStep {
  uses?: string;
  run?: string;
  with?: Record<string, string>;
}

interface Workflow {
  on?: {
    pull_request?: {
      paths?: string[];
    };
  };
  jobs?: Record<
    string,
    {
      steps?: WorkflowStep[];
    }
  >;
}

function readRepoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

function rootScriptDirectNxCommands(scripts: Record<string, string>): Array<[string, string]> {
  return Object.entries(scripts).filter(([, command]) => {
    if (!/\bnx\s/.test(command)) {
      return false;
    }
    return !command.includes('tools/toolchain/run.mjs nx ');
  });
}

function readWorkflow(path: string): Workflow {
  return YAML.parse(readRepoFile(path)) as Workflow;
}

function isRootWorkspaceRustFanout(step: WorkflowStep): boolean {
  const command = step.run ?? '';
  return [
    /npm run lint:all\b/,
    /npm run test:all\b/,
    /npm run build:all\b/,
    /npm run build --/,
    /affected-target-policy\.sh --target (?:lint|test)\b/,
    /npx nx affected -t (?:type-check|build)\b/,
    /npx nx run-many\b[^\n]*--all\b/,
  ].some((pattern) => pattern.test(command));
}

describe('Toolchain Config SSoT', () => {
  it('sets lint runtime env before loading Nx ESLint plugin', () => {
    const runtime = readRepoFile('tools/toolchain/toolchain-runtime.mjs');
    const eslintConfig = readRepoFile('eslint.config.mjs');

    expect(runtime).toContain('TOOLCHAIN_ESLINT_RUNTIME_ENV');
    expect(runtime).toContain('TOOLCHAIN_NX_RUNTIME_ENV');
    expect(runtime).toContain("NX_PREFER_NODE_STRIP_TYPES: 'true'");
    expect(runtime).toContain("NX_ISOLATE_PLUGINS: 'false'");
    expect(runtime).toContain('delete env.NX_PREFER_NODE_STRIP_TYPES;');
    expect(runtime).toContain('TOOLCHAIN_NODE_HEAP_FLOOR_MB = 4096');
    expect(runtime).toContain("NODE_HEAP_OPTION_PREFIX = '--max-old-space-size='");
    expect(runtime).toContain('Math.max(heapFloorMb, parsedHeapMb)');
    expect(runtime).toContain('delete env.NO_COLOR;');
    expect(eslintConfig).toContain(
      "import { applyToolchainRuntimeEnv } from './tools/toolchain/toolchain-runtime.mjs';",
    );
    expect(eslintConfig).toContain('applyToolchainRuntimeEnv();');
    expect(eslintConfig).not.toContain("from '@nx/eslint-plugin'");
    expect(eslintConfig.indexOf('applyToolchainRuntimeEnv();')).toBeLessThan(
      eslintConfig.indexOf("import('@nx/eslint-plugin')"),
    );
  });

  it('preserves caller-owned Node heap ceilings above the toolchain floor', () => {
    const script = `
      import { applyEslintRuntimeEnv } from './tools/toolchain/toolchain-runtime.mjs';

      const inheritedEnv = {
        NODE_OPTIONS: '--trace-warnings --max-old-space-size=6144',
      };
      applyEslintRuntimeEnv(inheritedEnv);
      if (!inheritedEnv.NODE_OPTIONS.includes('--max-old-space-size=6144')) {
        throw new Error(inheritedEnv.NODE_OPTIONS);
      }
      if (!inheritedEnv.NODE_OPTIONS.includes('--trace-warnings')) {
        throw new Error(inheritedEnv.NODE_OPTIONS);
      }

      const defaultEnv = {};
      applyEslintRuntimeEnv(defaultEnv);
      if (!defaultEnv.NODE_OPTIONS.includes('--max-old-space-size=4096')) {
        throw new Error(defaultEnv.NODE_OPTIONS);
      }
    `;

    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
  });

  it('ties Nx lint cache inputs to the toolchain runtime owner', () => {
    const nxJson = readRepoFile('nx.json');

    expect(nxJson).toContain('{workspaceRoot}/tools/toolchain/**');
  });

  it('overlays the toolchain runtime owner into base lint comparison worktrees', () => {
    const lintChangedFiles = readRepoFile('scripts/ci/lint-changed-files.mjs');

    expect(lintChangedFiles).toContain("':(glob)tools/toolchain/**/*.mjs'");
  });

  it('runs changed-file ESLint through the toolchain runner', () => {
    const lintChangedFiles = readRepoFile('scripts/ci/lint-changed-files.mjs');

    expect(lintChangedFiles).toContain("join(repoRoot, 'tools', 'toolchain', 'run.mjs')");
    expect(lintChangedFiles).toContain("prefixArgs: [toolchainRunner, 'eslint']");
  });

  it('does not solve deprecations by suppressing warnings', () => {
    const forbiddenTokens = [
      'NODE_NO_WARNINGS',
      '--no-deprecation',
      '--disable-warning=DeprecationWarning',
    ];
    const scannedFiles = [
      'package.json',
      '.husky/pre-commit',
      '.husky/pre-push',
      '.husky/commit-msg',
      '.github/workflows/ci-affected.yml',
      '.github/workflows/ci-full.yml',
      '.github/workflows/quality-gates.yml',
      'scripts/ci/lint-changed-files.sh',
      'scripts/ci/lint-changed-files.mjs',
    ];

    for (const file of scannedFiles) {
      const content = readRepoFile(file);
      for (const token of forbiddenTokens) {
        expect(content).not.toContain(token);
      }
    }
  });

  it('routes root Nx scripts and shared-ui ESLint scripts through the toolchain runner', () => {
    const packageJson = JSON.parse(readRepoFile('package.json')) as {
      scripts: Record<string, string>;
    };
    const sharedUiPackageJson = JSON.parse(readRepoFile('web/shared-ui/package.json')) as {
      scripts: Record<string, string>;
    };

    expect(rootScriptDirectNxCommands(packageJson.scripts)).toEqual([]);
    expect(sharedUiPackageJson.scripts.lint).toBe('node ../../tools/toolchain/run.mjs eslint src');
    expect(sharedUiPackageJson.scripts['lint:fix']).toBe(
      'node ../../tools/toolchain/run.mjs eslint src --fix',
    );
  });

  it('keeps Nx and ESLint process policies separated inside the runner', () => {
    const runner = readRepoFile('tools/toolchain/run.mjs');

    expect(runner).toContain("name === 'nx'");
    expect(runner).toContain("name === 'npx' && commandArgs[0] === 'nx'");
    expect(runner).toContain('applyNxRuntimeEnv();');
    expect(runner).toContain("commandBasename(command) === 'nx' ? 'npx' : command");
    expect(runner).toContain("commandBasename(command) === 'nx' ? ['nx', ...args] : args");
    expect(runner).toContain("name === 'eslint'");
    expect(runner).toContain("name === 'npx' && commandArgs[0] === 'eslint'");
    expect(runner).toContain('applyEslintRuntimeEnv();');
  });

  it('keeps ts-jest transpilation mode in the invariant tsconfig owner', () => {
    const jestConfig = readRepoFile('tests/invariants/jest.config.ts');
    const tsconfig = readRepoFile('tests/invariants/tsconfig.spec.json');

    expect(tsconfig).toContain('"isolatedModules": true');
    expect(jestConfig).toContain('tsconfig.spec.json');
    expect(jestConfig).not.toContain('isolatedModules: true');
  });

  it('keeps CI Nx invocations behind the toolchain runner', () => {
    const scannedFiles = [
      '.github/workflows/ci-affected.yml',
      '.github/workflows/ci-full.yml',
      '.github/workflows/deploy-digitalocean.yml',
      '.github/workflows/deploy-staging.yml',
      '.github/workflows/performance-benchmark.yml',
      'scripts/ci/affected-target-policy.sh',
    ];

    for (const file of scannedFiles) {
      const executableLines = readRepoFile(file)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .filter((line) => !line.startsWith('#'));

      for (const line of executableLines) {
        if (!line.includes('npx nx')) continue;
        expect(line).toContain('node tools/toolchain/run.mjs npx nx');
      }
    }
  });

  it('derives the workspace Rust setup from the verified generated manifest', () => {
    const action = YAML.parse(readRepoFile(`${RUST_SETUP_ACTION}/action.yml`)) as {
      runs?: {
        steps?: Array<WorkflowStep & { id?: string; name?: string }>;
      };
    };
    const steps = action.runs?.steps ?? [];
    const resolver = steps.find((step) => step.id === 'toolchain');
    const installer = steps.find((step) => step.uses?.startsWith('dtolnay/rust-toolchain@'));
    const verifier = steps.find((step) => step.name === 'Verify repository Rust toolchain');

    expect(resolver?.run).toBe('node "${{ github.action_path }}/resolve-toolchain.mjs"');
    expect(installer?.uses).toBe('dtolnay/rust-toolchain@67ef31d5b988238dd797d409d6f9574278e20537');
    expect(installer?.with).toEqual({
      toolchain: '${{ steps.toolchain.outputs.toolchain }}',
      components: '${{ steps.toolchain.outputs.components }}',
      targets: '${{ steps.toolchain.outputs.targets }}',
    });
    expect(verifier?.run).toBe(
      'node "$GITHUB_WORKSPACE/tools/quality/quality.mjs" rust-toolchain check',
    );

    const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'aqua-rust-toolchain-'));
    const githubOutput = resolve(temporaryDirectory, 'github-output');
    try {
      execFileSync(
        process.execPath,
        [resolve(REPO_ROOT, RUST_SETUP_ACTION, 'resolve-toolchain.mjs')],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            GITHUB_OUTPUT: githubOutput,
            GITHUB_WORKSPACE: REPO_ROOT,
          },
        },
      );

      const outputs: Record<string, string> = {};
      for (const line of readFileSync(githubOutput, 'utf8').trim().split('\n')) {
        const separator = line.indexOf('=');
        expect(separator).toBeGreaterThan(0);
        outputs[line.slice(0, separator)] = line.slice(separator + 1);
      }

      const manifest = JSON.parse(readRepoFile('tools/quality/rust-toolchain-manifest.json')) as {
        channel: string;
        components: string[];
        targets: string[];
      };
      expect(outputs).toEqual({
        toolchain: manifest.channel,
        components: manifest.components.join(','),
        targets: manifest.targets.join(','),
      });
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('prepares the complete Rust workspace before every broad root Nx fan-out', () => {
    const guardedJobs: string[] = [];

    for (const workflowPath of RUST_FANOUT_WORKFLOWS) {
      for (const [jobId, job] of Object.entries(readWorkflow(workflowPath).jobs ?? {})) {
        const steps = job.steps ?? [];
        const fanoutIndexes = steps
          .map((step, index) => (isRootWorkspaceRustFanout(step) ? index : -1))
          .filter((index) => index >= 0);
        if (fanoutIndexes.length === 0) continue;

        const setupIndexes = steps
          .map((step, index) => (step.uses === RUST_SETUP_ACTION ? index : -1))
          .filter((index) => index >= 0);
        guardedJobs.push(`${workflowPath}:${jobId}`);

        expect(setupIndexes).toHaveLength(1);
        expect(setupIndexes[0]).toBeLessThan(Math.min(...fanoutIndexes));
        expect(steps.some((step) => step.uses?.startsWith('dtolnay/rust-toolchain@'))).toBe(false);
      }
    }

    expect(guardedJobs.sort()).toEqual(
      [
        '.github/workflows/ci-affected.yml:build',
        '.github/workflows/ci-affected.yml:lint',
        '.github/workflows/ci-affected.yml:test',
        '.github/workflows/ci-full.yml:build',
        '.github/workflows/ci-full.yml:lint-and-typecheck',
        '.github/workflows/ci-full.yml:test',
        '.github/workflows/performance-benchmark.yml:lighthouse',
      ].sort(),
    );
  });

  it('reruns Lighthouse when its workspace Rust setup authority changes', () => {
    const paths = readWorkflow('.github/workflows/performance-benchmark.yml').on?.pull_request
      ?.paths;

    expect(paths).toEqual(
      expect.arrayContaining([
        '.github/actions/setup-rust-workspace/**',
        'rust-toolchain.toml',
        'tools/quality/rust-toolchain-manifest.json',
      ]),
    );
  });
});
