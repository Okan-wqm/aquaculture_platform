/**
 * Run an invariant spec against a throwaway repository instead of this one.
 *
 * WHY. The always-run invariants (finding-registry-integrity, the alias
 * sidecar, the evidence-shape advisory) judge the checkout they live in:
 * `REPO_ROOT` is the directory two levels above the spec. Whether such a spec
 * is red for a given history cannot be answered by reading its source; it is
 * answered by putting the history under the spec and running it. A spec copied
 * into a fixture repository resolves `REPO_ROOT` to that repository, so the
 * fixture carries the registry, the sidecar and the git history the test
 * builds, and the verdict is the spec's own.
 *
 * WHAT. `runSpecIn` writes the spec, its sibling constants and a minimal Jest
 * configuration into the fixture (all excluded from the fixture's own git
 * history, so a commit the test makes never contains them), runs the repository's
 * Jest on that one spec and returns each test's name and outcome. A caller
 * compares two runs (a healthy history and a tampered one) by test name, so a
 * test that fails on both for a reason of the fixture cancels out.
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { removeFixtureTree } from '../../../tools/gates/fixture-tree';
import { hermeticGitEnv } from '../../../tools/gates/hermetic-git';

import { REPO_ROOT, type RegistryFixtureRepo } from './registry-fixture-repo';

const SPEC_DIR = 'tests/invariants';
const JEST_TIMEOUT_MS = 240_000;

export interface SpecTestResult {
  /** The test's full name: its describe blocks, then its title. */
  readonly name: string;
  readonly status: 'passed' | 'failed' | 'pending';
  /** Jest's failure text; empty for a test that did not fail. */
  readonly message: string;
}

export interface SpecRun {
  readonly exitStatus: number | null;
  readonly tests: readonly SpecTestResult[];
  /** Jest's stderr when the run produced no result file (a configuration or compile failure). */
  readonly stderr: string;
}

export function failedTests(run: SpecRun): SpecTestResult[] {
  return run.tests.filter((test) => test.status === 'failed');
}

/** The names of the tests that fail in `after` and do not fail in `before`. */
export function newlyFailing(before: SpecRun, after: SpecRun): SpecTestResult[] {
  const already = new Set(failedTests(before).map((test) => test.name));
  return failedTests(after).filter((test) => !already.has(test.name));
}

const FIXTURE_TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'commonjs',
    esModuleInterop: true,
    strict: true,
    resolveJsonModule: true,
    isolatedModules: true,
    skipLibCheck: true,
    types: ['jest', 'node'],
  },
};

function excludeFromFixtureGit(repo: RegistryFixtureRepo, entries: readonly string[]): void {
  appendFileSync(join(repo.root, '.git', 'info', 'exclude'), `${entries.join('\n')}\n`, 'utf8');
}

/**
 * Put `specFile` (a file name under tests/invariants) and what it imports
 * from its own directory into `repo`, ready for `runSpecIn`. Call once per
 * fixture, before its first commit.
 */
export function installSpec(repo: RegistryFixtureRepo, specFile: string): void {
  excludeFromFixtureGit(repo, [
    `${SPEC_DIR}/`,
    'package.json',
    'jest.fixture.config.js',
    'tsconfig.fixture.json',
  ]);
  mkdirSync(join(repo.root, SPEC_DIR), { recursive: true });
  for (const name of [specFile, '_constants.ts']) {
    copyFileSync(join(REPO_ROOT, SPEC_DIR, name), join(repo.root, SPEC_DIR, name));
  }
  // A spec that reads the root manifest (the integrity spec checks the npm script it names).
  copyFileSync(join(REPO_ROOT, 'package.json'), join(repo.root, 'package.json'));
  writeFileSync(join(repo.root, 'tsconfig.fixture.json'), JSON.stringify(FIXTURE_TSCONFIG), 'utf8');
  writeFileSync(
    join(repo.root, 'jest.fixture.config.js'),
    [
      'module.exports = {',
      `  rootDir: ${JSON.stringify(join(repo.root, SPEC_DIR))},`,
      "  roots: ['<rootDir>'],",
      "  testEnvironment: 'node',",
      "  testMatch: ['<rootDir>/*.spec.ts'],",
      "  moduleFileExtensions: ['ts', 'js', 'json'],",
      '  watchman: false,',
      '  transform: {',
      "    '^.+\\\\.ts$': ['ts-jest', {",
      `      tsconfig: ${JSON.stringify(join(repo.root, 'tsconfig.fixture.json'))},`,
      '      diagnostics: false,',
      '      isolatedModules: true,',
      '    }],',
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf8',
  );
}

interface JestJson {
  readonly testResults: readonly {
    readonly assertionResults: readonly {
      readonly fullName: string;
      readonly status: SpecTestResult['status'];
      readonly failureMessages: readonly string[];
    }[];
  }[];
}

/** Run the installed spec `specFile` against the repository state `repo` has checked out. */
export function runSpecIn(repo: RegistryFixtureRepo, specFile: string): SpecRun {
  const scratch = mkdtempSync(join(tmpdir(), 'spec-in-fixture-'));
  const outputFile = join(scratch, 'result.json');
  try {
    const env = hermeticGitEnv();
    // The caller is itself a Jest worker; the child run must not inherit its identity.
    delete env.JEST_WORKER_ID;
    delete env.NODE_ENV;
    const run = spawnSync(
      join(REPO_ROOT, 'node_modules', '.bin', 'jest'),
      [
        '--config',
        join(repo.root, 'jest.fixture.config.js'),
        '--runInBand',
        '--json',
        `--outputFile=${outputFile}`,
        '--runTestsByPath',
        join(repo.root, SPEC_DIR, specFile),
      ],
      {
        cwd: repo.root,
        encoding: 'utf8',
        env,
        timeout: JEST_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    let parsed: JestJson | null = null;
    try {
      parsed = JSON.parse(readFileSync(outputFile, 'utf8')) as JestJson;
    } catch {
      parsed = null;
    }
    const tests = (parsed?.testResults ?? []).flatMap((file) =>
      file.assertionResults.map(
        (result): SpecTestResult => ({
          name: result.fullName,
          status: result.status,
          message: result.failureMessages.join('\n'),
        }),
      ),
    );
    return {
      exitStatus: run.status,
      tests,
      stderr: `${run.stderr ?? ''}${run.error ? String(run.error) : ''}`,
    };
  } finally {
    removeFixtureTree(scratch);
  }
}
