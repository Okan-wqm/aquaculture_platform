import * as fs from 'node:fs';
import * as path from 'node:path';

interface CoverageMetric {
  covered: number;
  found: number;
  percentage: number;
}

interface ParsedCoverage {
  source_files: number;
  branches: CoverageMetric;
  functions: CoverageMetric;
  lines: CoverageMetric;
}

const coverageEvidence: {
  parseLcov(content: string, reportPath: string): ParsedCoverage;
} = require('../../tools/quality/coverage-evidence.js');
const createVitestTestPolicy: () => {
  maxWorkers: number;
  testTimeout: number;
  coverage: { provider: string; reporter: string[] };
} = require('@aquaculture/testing/vitest');
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INVENTORY_PATH = path.join(REPO_ROOT, 'tools', 'quality', 'coverage-report-inventory.json');
const NX_JSON_PATH = path.join(REPO_ROOT, 'nx.json');

function readInventory(): { schema_version: number; reports: string[] } {
  return JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8'));
}

/**
 * Two conventions produce the inventory. Jest writes into the workspace-root
 * tree (`coverage/<projectRoot>/lcov.info`); Vitest writes beside the project
 * (`<projectRoot>/coverage/lcov.info`). Either way the report path names its
 * own producer, which is what lets these contracts check a project without a
 * second list to keep in sync.
 */
function projectRootOf(report: string): string {
  return report.startsWith('coverage/')
    ? path.dirname(report.slice('coverage/'.length))
    : path.dirname(path.dirname(report));
}

function testTargetOf(projectRoot: string): Record<string, unknown> | undefined {
  const projectJsonPath = path.join(REPO_ROOT, projectRoot, 'project.json');
  if (!fs.existsSync(projectJsonPath)) {
    return undefined;
  }
  const targets = (
    JSON.parse(fs.readFileSync(projectJsonPath, 'utf8')) as {
      targets?: Record<string, Record<string, unknown>>;
    }
  ).targets;
  return targets?.test;
}
const VITEST_CONFIGS = [
  'libs/aquaculture-engines/vitest.config.ts',
  'web/modules/admin-panel/vite.config.ts',
  'web/modules/dashboard/vite.config.ts',
  'web/modules/farm-module/vite.config.ts',
  'web/modules/hr-module/vite.config.ts',
  'web/modules/messaging-module/vite.config.ts',
  'web/modules/sensor-module/vite.config.ts',
  'web/modules/tenant-admin/vite.config.ts',
  'web/shared-ui/vitest.config.ts',
  'web/shell/vitest.config.ts',
];

describe('repository-owned coverage evidence contract', () => {
  it('keeps every JS/TS coverage producer in one sorted, duplicate-free inventory', () => {
    const inventory = readInventory();

    expect(inventory.schema_version).toBe(1);
    expect(inventory.reports).toHaveLength(34);
    expect(new Set(inventory.reports).size).toBe(inventory.reports.length);
    expect(inventory.reports).toEqual([...inventory.reports].sort());
    expect(
      inventory.reports.every(
        (report) =>
          !path.isAbsolute(report) && !report.includes('..') && report.endsWith('lcov.info'),
      ),
    ).toBe(true);
  });

  it('aggregates LCOV counters deterministically across source records', () => {
    const parsed = coverageEvidence.parseLcov(
      [
        'SF:src/one.ts',
        'FNF:2',
        'FNH:1',
        'BRF:4',
        'BRH:3',
        'LF:10',
        'LH:8',
        'end_of_record',
        'SF:src/two.ts',
        'FNF:1',
        'FNH:1',
        'BRF:2',
        'BRH:1',
        'LF:5',
        'LH:4',
        'end_of_record',
      ].join('\n'),
      'fixture/lcov.info',
    );

    expect(parsed).toEqual({
      source_files: 2,
      branches: { covered: 4, found: 6, percentage: 66.67 },
      functions: { covered: 2, found: 3, percentage: 66.67 },
      lines: { covered: 12, found: 15, percentage: 80 },
    });
  });

  it('bounds nested Vitest worker pools and gives every producer the same LCOV policy', () => {
    expect(createVitestTestPolicy()).toEqual({
      maxWorkers: 2,
      testTimeout: 30_000,
      coverage: {
        provider: 'v8',
        reporter: ['text', 'lcov'],
      },
    });

    for (const configPath of VITEST_CONFIGS) {
      const config = fs.readFileSync(path.join(REPO_ROOT, configPath), 'utf8');
      expect(config).toContain('@aquaculture/testing/vitest');

      // The property this contract is really after is that the config SPREADS
      // the shared policy — not that it spells the spread one exact way. Two
      // spellings do that:
      //
      //   ...createVitestTestPolicy()        the factory call spread inline
      //   const p = createVitestTestPolicy(); … ...p
      //
      // The bound form is not a loophole, it is a necessity: a config that also
      // EXTENDS the policy (shared-ui adds its own coverage include/exclude)
      // has to name the result to read `coverage` back off it while overriding
      // that same key. Demanding the inline spelling forbade the only correct
      // way to write shared-ui, which is how it ended up referencing an
      // unbound `testPolicy` and taking the type-check and shared-ui:test jobs
      // down with it.
      // The binding must be spread WHOLE. `...testPolicy.coverage` is a spread
      // of one property and proves nothing about maxWorkers, so the pattern
      // refuses a trailing `.` or `[` — without that, a config could drop the
      // policy spread entirely, keep only its coverage extension, and still
      // satisfy this contract.
      const bound = /const\s+([A-Za-z_$][\w$]*)\s*=\s*createVitestTestPolicy\(\)/.exec(config);
      const spreadsPolicy =
        config.includes('...createVitestTestPolicy()') ||
        (bound !== null && new RegExp(`\\.\\.\\.${bound[1]}(?![\\w$.[])`).test(config));

      if (!spreadsPolicy) {
        throw new Error(
          `${configPath} imports the shared Vitest policy but never spreads it. ` +
            `Spread the factory call directly (\`...createVitestTestPolicy()\`), or bind it ` +
            `once (\`const testPolicy = createVitestTestPolicy()\`) and spread that binding.`,
        );
      }
    }
  });

  it('returns an isolated reporter array for every config consumer', () => {
    const first = createVitestTestPolicy();
    const second = createVitestTestPolicy();

    expect(first).not.toBe(second);
    expect(first.coverage.reporter).not.toBe(second.coverage.reporter);
  });

  it('lets the forwarded --coverage flag reach every producer rather than npm', () => {
    // `npm run test:all -- --coverage` becomes `nx run-many --target=test --all
    // --coverage`, and Nx forwards that flag to each task. An `nx:run-commands`
    // target APPENDS forwarded args to its command string, so a target spelled
    // `command: "npm run test"` ran as `npm run test --coverage` — where npm
    // reads `--coverage` as one of ITS OWN config flags and never hands it to
    // the test runner. Eight producers therefore ran with coverage silently
    // off and wrote no report at all, which is how the evidence gate came to
    // fail on a run whose tests had all passed. The `--` separator is what
    // makes an appended flag reach the script; without it, the wrapper must go
    // and the target must be the one Nx infers from the package.json script
    // (`nx:run-script`), which forwards options properly.
    const offenders: string[] = [];

    for (const report of readInventory().reports) {
      const projectRoot = projectRootOf(report);
      const target = testTargetOf(projectRoot);
      if (target === undefined) {
        continue;
      }
      const options = (target.options ?? {}) as { command?: string; commands?: string[] };
      const commands = [options.command, ...(options.commands ?? [])].filter(
        (command): command is string => typeof command === 'string',
      );
      for (const command of commands) {
        if (/\b(?:npm|yarn|pnpm)\s+run\b/.test(command) && !command.trimEnd().endsWith('--')) {
          offenders.push(`${projectRoot}: ${command}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('lets no spec cap its own timeout below the shared policy', () => {
    // The policy timeout is sized for the worst case it must survive: a chart
    // render, under v8 instrumentation, on a contended two-core runner. A
    // per-test third argument overrides it — and the ones that existed all
    // overrode it DOWNWARD, on precisely the heaviest tests, because they were
    // written against Vitest's 5s default and outlived the config that had
    // already raised it. Raising a single test above the policy is a decision;
    // silently lowering the heaviest ones is how the suite goes red the first
    // time the machine is busy.
    const policyTimeout = createVitestTestPolicy().testTimeout;
    const undercuts: string[] = [];

    for (const configPath of VITEST_CONFIGS) {
      const projectRoot = path.join(REPO_ROOT, path.dirname(configPath), 'src');
      if (!fs.existsSync(projectRoot)) {
        continue;
      }
      const specs = fs
        .readdirSync(projectRoot, { recursive: true, encoding: 'utf8' })
        .filter((entry) => /\.(?:spec|test)\.tsx?$/.test(entry));

      for (const spec of specs) {
        const specPath = path.join(projectRoot, spec);
        // Pair an `it(`/`test(` with the `}, <ms>);` that closes it at the
        // same indentation. Anchoring on the indent is what separates a test's
        // timeout argument from an ordinary `setTimeout(fn, 0)` further in.
        for (const match of fs
          .readFileSync(specPath, 'utf8')
          .matchAll(/^([ \t]*)(?:it|test)(?:\.\w+)*\([\s\S]*?^\1\}, ([0-9_]+)\);/gm)) {
          const literal = match[2];
          if (literal === undefined) {
            continue;
          }
          if (Number(literal.replace(/_/g, '')) < policyTimeout) {
            undercuts.push(`${path.relative(REPO_ROOT, specPath)}: ${literal}`);
          }
        }
      }
    }

    expect(undercuts).toEqual([]);
  });

  it('caches the coverage directory, so a replayed test still leaves its evidence', () => {
    // The other half of the same failure. `test` is a cached target and CI
    // restores `.nx/cache` between runs, so most test tasks replay rather than
    // execute. Nx restores exactly the paths a target declares as `outputs` —
    // a cached target that declares none writes no files on replay, and the
    // evidence gate fails for a producer that legitimately has nothing to do.
    // The default covers both layouts because both exist in the inventory.
    const nxJson = JSON.parse(fs.readFileSync(NX_JSON_PATH, 'utf8')) as {
      targetDefaults: { test: { cache: boolean; outputs: string[] } };
    };

    expect(nxJson.targetDefaults.test.cache).toBe(true);
    expect(nxJson.targetDefaults.test.outputs).toEqual([
      '{workspaceRoot}/coverage/{projectRoot}',
      '{projectRoot}/coverage',
    ]);

    // A project may narrow that default, but only to somewhere its own report
    // actually lands — an override pointing at the other convention's path
    // caches nothing and is worse than no override at all.
    const misdirected: string[] = [];

    for (const report of readInventory().reports) {
      const projectRoot = projectRootOf(report);
      const declared = testTargetOf(projectRoot)?.outputs as string[] | undefined;
      if (declared === undefined) {
        continue;
      }
      const resolved = declared.map((output) =>
        output.replace('{workspaceRoot}/', '').replace('{projectRoot}', projectRoot),
      );
      if (!resolved.includes(path.dirname(report))) {
        misdirected.push(`${projectRoot}: ${resolved.join(', ')} misses ${path.dirname(report)}`);
      }
    }

    expect(misdirected).toEqual([]);
  });

  it('rejects syntactically present reports with no instrumented source lines', () => {
    expect(() => coverageEvidence.parseLcov('TN:\\nend_of_record\\n', 'empty/lcov.info')).toThrow(
      'LCOV contains no instrumented source lines',
    );
  });
});
