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
  verifyCoverage(
    root?: string,
    options?: { rewrite?: boolean },
  ): { ratchet: { serviceName: string }[] };
  rewriteBaselines(ratchet: { serviceName: string; metrics: ParsedCoverage }[]): string[];
  RATCHET_MIN_GAIN: number;
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

interface DeclaredTestTarget {
  source: string;
  target: Record<string, unknown>;
}

interface VitestProducer {
  root: string;
  config: string;
  report: string;
}

function declaredTestTargetsOf(projectRoot: string): DeclaredTestTarget[] {
  const declared: DeclaredTestTarget[] = [];
  const projectJsonPath = path.join(REPO_ROOT, projectRoot, 'project.json');
  if (fs.existsSync(projectJsonPath)) {
    const target = (
      JSON.parse(fs.readFileSync(projectJsonPath, 'utf8')) as {
        targets?: Record<string, Record<string, unknown>>;
      }
    ).targets?.test;
    if (target !== undefined) {
      declared.push({ source: path.relative(REPO_ROOT, projectJsonPath), target });
    }
  }

  const packageJsonPath = path.join(REPO_ROOT, projectRoot, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    const target = (
      JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
        nx?: { targets?: Record<string, Record<string, unknown>> };
      }
    ).nx?.targets?.test;
    if (target !== undefined) {
      declared.push({ source: path.relative(REPO_ROOT, packageJsonPath), target });
    }
  }

  return declared;
}

function discoverVitestProducers(): VitestProducer[] {
  const producers: VitestProducer[] = [];
  const ignoredDirectories = new Set(['coverage', 'dist', 'node_modules', 'target']);

  function visit(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          visit(absolute);
        }
        continue;
      }
      if (entry.name !== 'package.json') {
        continue;
      }

      const packageJson = JSON.parse(fs.readFileSync(absolute, 'utf8')) as {
        scripts?: { test?: string };
      };
      if (!/\bvitest\b/.test(packageJson.scripts?.test ?? '')) {
        continue;
      }

      const root = path.relative(REPO_ROOT, path.dirname(absolute));
      const configName = ['vitest.config.ts', 'vite.config.ts'].find((candidate) =>
        fs.existsSync(path.join(REPO_ROOT, root, candidate)),
      );
      if (configName === undefined) {
        throw new Error(`${root} runs Vitest but has no Vitest/Vite config`);
      }
      producers.push({
        root,
        config: path.join(root, configName),
        report: path.join(root, 'coverage', 'lcov.info'),
      });
    }
  }

  for (const scope of ['apps', 'libs', 'mcp', 'platform', 'tests', 'web']) {
    visit(path.join(REPO_ROOT, scope));
  }

  return producers.sort((left, right) => left.root.localeCompare(right.root));
}

const VITEST_PRODUCERS = discoverVitestProducers();

describe('repository-owned coverage evidence contract', () => {
  it('keeps every JS/TS coverage producer in one sorted, duplicate-free inventory', () => {
    const inventory = readInventory();

    expect(inventory.schema_version).toBe(1);
    expect(inventory.reports).toHaveLength(36);
    expect(new Set(inventory.reports).size).toBe(inventory.reports.length);
    expect(inventory.reports).toEqual([...inventory.reports].sort());
    expect(
      inventory.reports.every(
        (report) =>
          !path.isAbsolute(report) && !report.includes('..') && report.endsWith('lcov.info'),
      ),
    ).toBe(true);
    expect(VITEST_PRODUCERS).toHaveLength(12);
    expect(inventory.reports.filter((report) => !report.startsWith('coverage/'))).toEqual(
      VITEST_PRODUCERS.map(({ report }) => report),
    );
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

  // The pinned per-service floors are enforced two ways — jest reads them as
  // `coverageThreshold.global`, and coverage-evidence.js refuses a report
  // below them. Both only ever looked DOWN: a service whose coverage rose kept
  // the old pin, the improvement was never captured, and the next change could
  // eat it back in silence. A ratchet with a pawl on one side is a floor, not
  // a ratchet.
  it('captures a material coverage gain instead of leaving the floor behind', () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'tools', 'quality', 'coverage-evidence.js'),
      'utf8',
    );
    // The gain must be re-pinned, and the message must carry the command that
    // does it — a gate that says "wrong" without saying "here" is a riddle.
    expect(source).toContain('RATCHET_MIN_GAIN');
    expect(source).toContain('coverage ROSE and the baseline was left behind');
    expect(source).toContain('node tools/quality/coverage-evidence.js --write');
    // Jitter between runs is fractions of a point; one point is the smallest
    // gain that is a change in the code rather than in the weather.
    expect(coverageEvidence.RATCHET_MIN_GAIN).toBe(1.0);
    // Monotonic: the writer raises and never lowers. A measurement below the
    // pin is already an error, so --write can never become the way a floor
    // gets quietly reduced.
    expect(source).toContain('if (measured > current[metric])');
    expect(source).toContain('NEVER lowers one');
  });

  it('keeps every pinned baseline reachable from the jest configs that enforce it', () => {
    const baselines = JSON.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, 'tools', 'quality', 'service-coverage-baselines.json'),
        'utf8',
      ),
    ) as Record<string, Record<string, number>>;
    // A pin nothing enforces is decoration. Every service with a baseline must
    // import it as its jest coverageThreshold — the ratchet is only worth
    // anything where the floor is actually load-bearing.
    for (const service of Object.keys(baselines)) {
      const configPath = path.join(REPO_ROOT, 'apps', service, 'jest.config.ts');
      expect(fs.existsSync(configPath)).toBe(true);
      const config = fs.readFileSync(configPath, 'utf8');
      expect(config).toContain('service-coverage-baselines');
      expect(config).toContain(`coverageBaselines['${service}']`);
    }
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

    for (const { config: configPath } of VITEST_PRODUCERS) {
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

  it('keeps Vitest producers on the inferred test runner so forwarded flags reach Vitest', () => {
    // `npm run test:all -- --coverage` becomes `nx run-many --target=test --all
    // --coverage`, and Nx forwards that flag to each task. An `nx:run-commands`
    // target APPENDS forwarded args to its command string, so targets wrapping
    // either `npm run test` or its `npm test` shorthand swallow `--coverage`
    // as an npm config option. Nx also accepts a top-level `command` shorthand
    // for that executor, and package.json can declare the same override under
    // `nx.targets`. None of those wrappers may exist: the target Nx infers from
    // the package.json script (`nx:run-script`) forwards options properly. A
    // target may still add metadata such as `dependsOn` without replacing the
    // inferred executor (admin-panel does this).
    const offenders: string[] = [];
    const targetDefault = (
      JSON.parse(fs.readFileSync(NX_JSON_PATH, 'utf8')) as {
        targetDefaults?: { test?: Record<string, unknown> };
      }
    ).targetDefaults?.test;

    if (targetDefault !== undefined) {
      if ('executor' in targetDefault) {
        offenders.push('nx.json: explicit test executor');
      }
      if ('command' in targetDefault) {
        offenders.push('nx.json: explicit test command shorthand');
      }
    }

    for (const { root: projectRoot } of VITEST_PRODUCERS) {
      for (const { source, target } of declaredTestTargetsOf(projectRoot)) {
        if ('executor' in target) {
          offenders.push(`${source}: explicit test executor`);
        }
        if ('command' in target) {
          offenders.push(`${source}: explicit test command shorthand`);
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

    for (const { config: configPath } of VITEST_PRODUCERS) {
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
      for (const { source, target } of declaredTestTargetsOf(projectRoot)) {
        const declared = target.outputs as string[] | undefined;
        if (declared === undefined) {
          continue;
        }
        const resolved = declared.map((output) =>
          output.replace('{workspaceRoot}/', '').replace('{projectRoot}', projectRoot),
        );
        if (!resolved.includes(path.dirname(report))) {
          misdirected.push(`${source}: ${resolved.join(', ')} misses ${path.dirname(report)}`);
        }
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
