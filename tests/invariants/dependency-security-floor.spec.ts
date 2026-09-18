import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as YAML from 'yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');
const NX_VERSION = '22.7.8';
const VITEST_VERSION = '3.2.7';
const ROUTER_VERSION = '7.18.2';
const API_EXTRACTOR_VERSION = '7.59.0';
const E2E_SECURITY_FLOORS = {
  '@babel/core': '7.29.7',
  'brace-expansion': '1.1.18',
  'fast-uri': '3.1.6',
} as const;

const NX_PACKAGES = [
  'nx',
  '@nx/eslint',
  '@nx/eslint-plugin',
  '@nx/jest',
  '@nx/js',
  '@nx/nest',
  '@nx/node',
  '@nx/react',
  '@nx/vite',
  '@nx/vitest',
  '@nx/workspace',
] as const;

const VITEST_WORKSPACES = [
  'libs/aquaculture-engines/package.json',
  'mcp/farm-management/package.json',
  'web/modules/admin-panel/package.json',
  'web/modules/dashboard/package.json',
  'web/modules/farm-module/package.json',
  'web/modules/hr-module/package.json',
  'web/modules/hydroponics-module/package.json',
  'web/modules/messaging-module/package.json',
  'web/modules/sensor-module/package.json',
  'web/modules/tenant-admin/package.json',
  'web/shared-ui/package.json',
  'web/shell/package.json',
] as const;

const ROUTER_CONSUMERS = [
  'web/apps/aquamobil/package.json',
  'web/modules/admin-panel/package.json',
  'web/modules/dashboard/package.json',
  'web/modules/farm-module/package.json',
  'web/modules/hr-module/package.json',
  'web/modules/hydroponics-module/package.json',
  'web/modules/messaging-module/package.json',
  'web/modules/sensor-module/package.json',
  'web/modules/tenant-admin/package.json',
  'web/shared-ui/package.json',
  'web/shell/package.json',
] as const;

const FEDERATION_CONSUMERS = [
  'web/modules/admin-panel/package.json',
  'web/modules/dashboard/package.json',
  'web/modules/farm-module/package.json',
  'web/modules/hr-module/package.json',
  'web/modules/hydroponics-module/package.json',
  'web/modules/messaging-module/package.json',
  'web/modules/sensor-module/package.json',
  'web/modules/tenant-admin/package.json',
  'web/shell/package.json',
] as const;

const DTS_CONSUMERS = ['libs/node-components/package.json', 'web/shared-ui/package.json'] as const;

interface PackageManifest {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
}

interface AuditGraph {
  command: string;
  json: string;
  markdown: string;
  status: string;
  /** `--level` and `--scope` the gate step must pass for this graph. */
  level: string;
  scope: string;
}

interface Lockfile {
  packages?: Record<
    string,
    {
      version?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    }
  >;
}

interface Workflow {
  jobs?: Record<
    string,
    {
      if?: string;
      outputs?: Record<string, string>;
      steps?: Array<{
        id?: string;
        name?: string;
        if?: string;
        run?: string;
        with?: Record<string, string | number | boolean>;
      }>;
    }
  >;
}

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readRepoFile(relativePath)) as T;
}

function declarationFromManifest(
  manifest: PackageManifest,
  dependency: string,
): string | undefined {
  return (
    manifest.dependencies?.[dependency] ??
    manifest.devDependencies?.[dependency] ??
    manifest.optionalDependencies?.[dependency] ??
    manifest.peerDependencies?.[dependency]
  );
}

function declaration(manifestPath: string, dependency: string): string | undefined {
  return declarationFromManifest(readJson<PackageManifest>(manifestPath), dependency);
}

/**
 * The audit step's job is to PRODUCE every graph — the JSON report and its
 * source map — without letting a failure in one silence the next. It no longer
 * renders the verdict: npm's exit code is all-or-nothing, so one advisory with
 * no safe remediation turned this REQUIRED check permanently red, and a
 * permanently red required check stops being read. The verdict moved to
 * `scripts/ci/npm-audit-gate.mjs`, which applies dated, reviewed exceptions
 * (`scripts/ci/npm-audit-exceptions.json`, guarded by
 * npm-audit-exception-ssot.spec.ts) and fails on everything else. What still
 * MUST hold here is that the source map runs for every graph and that its own
 * failure is not swallowed — a missing report is a graph nobody can review.
 */
function auditScriptSatisfiesContract(script: string, graphs: readonly AuditGraph[]): boolean {
  const lines = script.split(/\r?\n/).map((line) => line.trim());
  if (lines.at(-1) === '') lines.pop();

  let cursor = 0;
  if (lines[cursor] !== 'set +e') return false;

  for (const graph of graphs) {
    const expectedCapture = [
      graph.command,
      `node scripts/ci/audit-source-map.mjs ${graph.json} ${graph.markdown}`,
      `${graph.status}_MAP_STATUS=$?`,
    ];
    for (const expectedLine of expectedCapture) {
      cursor += 1;
      if (lines[cursor] !== expectedLine) return false;
    }
  }

  cursor += 1;
  if (lines[cursor] !== 'set -e') return false;

  for (const graph of graphs) {
    const variable = `${graph.status}_MAP_STATUS`;
    const expectedFailureBranch = [
      `if [ "$${variable}" -ne 0 ]; then`,
      `exit "$${variable}"`,
      'fi',
    ];
    for (const expectedLine of expectedFailureBranch) {
      cursor += 1;
      if (lines[cursor] !== expectedLine) return false;
    }
  }

  return cursor === lines.length - 1;
}

/**
 * Every graph the step produces must also be JUDGED. A report that is written,
 * uploaded and never gated is the shape of gate this programme keeps finding
 * inert, so the gate invocation is matched per graph rather than by presence.
 */
function gateStepCovers(script: string, graphs: readonly AuditGraph[]): string[] {
  const normalised = script.replace(/\\\n\s+/g, ' ').replace(/\s+/g, ' ');
  return graphs
    .filter(
      (graph) =>
        !normalised.includes(
          `node scripts/ci/npm-audit-gate.mjs --audit ${graph.json} ` +
            `--level ${graph.level} --scope ${graph.scope} ` +
            `--exceptions scripts/ci/npm-audit-exceptions.json`,
        ),
    )
    .map((graph) => graph.json);
}

function trackedManifestsDeclaring(dependency: string): readonly string[] {
  const paths = execFileSync('git', ['ls-files', '-z', '--', '**/package.json', 'package.json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);

  return paths.filter((path) => declaration(path, dependency) !== undefined).sort();
}

function resolvedVersions(lock: Lockfile, dependency: string): readonly string[] {
  const versions = new Set<string>();
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (
      (path === `node_modules/${dependency}` || path.endsWith(`/node_modules/${dependency}`)) &&
      entry.version
    ) {
      versions.add(entry.version);
    }
  }
  return [...versions].sort();
}

function scopedPackageResolutions(
  lock: Lockfile,
  scope: '@nx' | '@vitest',
): readonly { path: string; version: string | undefined }[] {
  const packageDirectory = new RegExp(`(?:^|node_modules/)${scope}/[^/]+$`);
  return Object.entries(lock.packages ?? {})
    .filter(([path]) => packageDirectory.test(path))
    .map(([path, entry]) => ({ path, version: entry.version }));
}

function comparable(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  return major * 1_000_000 + minor * 1_000 + patch;
}

describe('JavaScript dependency security floor', () => {
  test.each([
    ['optionalDependencies', { optionalDependencies: { vitest: '^3.2.7' } }],
    ['peerDependencies', { peerDependencies: { vitest: '^3.2.7' } }],
  ] as const)('dependency discovery includes %s declarations', (_field, manifest) => {
    expect(declarationFromManifest(manifest, 'vitest')).toBe('^3.2.7');
  });

  test('audit graph contract rejects report-capture and exit-body mutants', () => {
    const graph: AuditGraph = {
      command: 'npm audit --audit-level=high --json > npm-audit-root-full.json',
      json: 'npm-audit-root-full.json',
      markdown: 'npm-audit-root-full.md',
      status: 'ROOT_FULL',
      level: 'high',
      scope: 'root-full',
    };
    const valid = [
      'set +e',
      graph.command,
      `node scripts/ci/audit-source-map.mjs ${graph.json} ${graph.markdown}`,
      `${graph.status}_MAP_STATUS=$?`,
      'set -e',
      `if [ "$${graph.status}_MAP_STATUS" -ne 0 ]; then`,
      `  exit "$${graph.status}_MAP_STATUS"`,
      'fi',
    ].join('\n');
    const mutants = [
      // The source map stops running for this graph.
      valid.replace(`node scripts/ci/audit-source-map.mjs ${graph.json} ${graph.markdown}\n`, ''),
      // Its failure is swallowed before the status is captured.
      valid.replace(
        `node scripts/ci/audit-source-map.mjs ${graph.json} ${graph.markdown}`,
        `node scripts/ci/audit-source-map.mjs ${graph.json} ${graph.markdown} || true`,
      ),
      // The captured status is never acted on.
      valid.replace(`  exit "$${graph.status}_MAP_STATUS"`, '  true'),
      // A stray command displaces the capture from the command it belongs to.
      valid.replace(`${graph.status}_MAP_STATUS=$?`, `true\n${graph.status}_MAP_STATUS=$?`),
    ];

    expect(auditScriptSatisfiesContract(valid, [graph])).toBe(true);
    expect(mutants.map((script) => auditScriptSatisfiesContract(script, [graph]))).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  test('gate coverage check names the graph whose verdict step is missing', () => {
    const graph: AuditGraph = {
      command: 'npm audit --audit-level=high --json > npm-audit-root-full.json',
      json: 'npm-audit-root-full.json',
      markdown: 'npm-audit-root-full.md',
      status: 'ROOT_FULL',
      level: 'high',
      scope: 'root-full',
    };
    const covering =
      'node scripts/ci/npm-audit-gate.mjs --audit npm-audit-root-full.json \\\n' +
      '  --level high --scope root-full --exceptions scripts/ci/npm-audit-exceptions.json';
    expect(gateStepCovers(covering, [graph])).toEqual([]);
    // A graph produced but never judged, and a graph judged at the wrong level.
    expect(gateStepCovers('', [graph])).toEqual([graph.json]);
    expect(gateStepCovers(covering.replace('--level high', '--level critical'), [graph])).toEqual([
      graph.json,
    ]);
  });

  test('keeps the direct Nx family and root Vitest pair exactly coherent', () => {
    const manifest = readJson<PackageManifest>('package.json');
    const lock = readJson<Lockfile>('package-lock.json');

    for (const dependency of NX_PACKAGES) {
      expect({ dependency, declared: manifest.devDependencies?.[dependency] }).toEqual({
        dependency,
        declared: NX_VERSION,
      });
      expect({ dependency, resolved: resolvedVersions(lock, dependency) }).toEqual({
        dependency,
        resolved: [NX_VERSION],
      });
    }

    const nxFamily = scopedPackageResolutions(lock, '@nx');
    expect(nxFamily.length).toBeGreaterThan(0);
    for (const resolution of nxFamily) {
      expect(resolution).toEqual({ path: resolution.path, version: NX_VERSION });
    }

    expect(manifest.devDependencies?.vitest).toBe(VITEST_VERSION);
    expect(manifest.devDependencies?.['@vitest/coverage-v8']).toBe(VITEST_VERSION);
    expect(resolvedVersions(lock, 'vitest')).toEqual([VITEST_VERSION]);
    expect(resolvedVersions(lock, '@vitest/coverage-v8')).toEqual([VITEST_VERSION]);
    expect(lock.packages?.['node_modules/@vitest/coverage-v8']?.peerDependencies?.vitest).toBe(
      VITEST_VERSION,
    );
    const vitestFamily = scopedPackageResolutions(lock, '@vitest');
    expect(vitestFamily.length).toBeGreaterThan(0);
    for (const resolution of vitestFamily) {
      expect(resolution).toEqual({ path: resolution.path, version: VITEST_VERSION });
    }
  });

  test('enumerates every Vitest workspace and enforces the patched lower bound', () => {
    expect(trackedManifestsDeclaring('vitest')).toEqual(
      ['package.json', ...VITEST_WORKSPACES].sort(),
    );
    for (const manifestPath of VITEST_WORKSPACES) {
      expect({ manifestPath, vitest: declaration(manifestPath, 'vitest') }).toEqual({
        manifestPath,
        vitest: `^${VITEST_VERSION}`,
      });
    }
  });

  test('keeps the Hydroponics Router regression on the shared jsdom runner', () => {
    const manifest = readJson<PackageManifest>('web/modules/hydroponics-module/package.json');
    const vite = readRepoFile('web/modules/hydroponics-module/vite.config.ts');
    const project = readJson<{
      targets?: Record<string, { dependsOn?: string[] }>;
    }>('web/modules/hydroponics-module/project.json');

    expect(manifest.scripts).toMatchObject({
      test: 'vitest run',
      'test:watch': 'vitest',
    });
    expect(manifest.devDependencies).toMatchObject({
      '@testing-library/dom': '^10.4.1',
      '@testing-library/jest-dom': '^6.2.0',
      '@testing-library/react': '^16.3.2',
      '@testing-library/user-event': '^14.5.2',
      jsdom: '^24.0.0',
      vitest: '^3.2.7',
    });
    expect(vite).toContain("import { defineConfig } from 'vitest/config';");
    expect(vite).toContain("environment: 'jsdom'");
    expect(vite).toContain('...createVitestTestPolicy()');
    expect(project.targets?.test?.dependsOn).toEqual(['shared-ui:build']);
  });

  test('pins DOMPurify in the sensor manifest and root override', () => {
    const root = readJson<PackageManifest>('package.json');
    const lock = readJson<Lockfile>('package-lock.json');

    expect(declaration('web/modules/sensor-module/package.json', 'dompurify')).toBe('3.4.14');
    expect(root.overrides?.dompurify).toBe('3.4.14');
    expect(resolvedVersions(lock, 'dompurify')).toEqual(['3.4.14']);
  });

  test('enumerates every router consumer and pins both v7 singletons, SSoT, and locks', () => {
    expect(trackedManifestsDeclaring('react-router-dom')).toEqual([...ROUTER_CONSUMERS].sort());
    expect(trackedManifestsDeclaring('react-router')).toEqual([...ROUTER_CONSUMERS].sort());
    for (const manifestPath of ROUTER_CONSUMERS) {
      expect({
        manifestPath,
        reactRouter: declaration(manifestPath, 'react-router'),
        reactRouterDom: declaration(manifestPath, 'react-router-dom'),
      }).toEqual({
        manifestPath,
        reactRouter: ROUTER_VERSION,
        reactRouterDom: ROUTER_VERSION,
      });
    }

    const federationSsot = readRepoFile('web/shared-ui/src/federation/federationSharedConfig.ts');
    for (const dependency of ['react-router', 'react-router-dom']) {
      expect(federationSsot).toContain(`'${dependency}': '${ROUTER_VERSION}'`);
    }
    for (const lockPath of ['package-lock.json', 'web/apps/aquamobil/package-lock.json']) {
      const lock = readJson<Lockfile>(lockPath);
      expect({ lockPath, reactRouter: resolvedVersions(lock, 'react-router') }).toEqual({
        lockPath,
        reactRouter: [ROUTER_VERSION],
      });
      expect({ lockPath, reactRouterDom: resolvedVersions(lock, 'react-router-dom') }).toEqual({
        lockPath,
        reactRouterDom: [ROUTER_VERSION],
      });
    }
  });

  test('enumerates federation and declaration-generation consumers at patched floors', () => {
    expect(trackedManifestsDeclaring('@module-federation/vite')).toEqual(
      [...FEDERATION_CONSUMERS].sort(),
    );
    for (const manifestPath of FEDERATION_CONSUMERS) {
      expect({
        manifestPath,
        federation: declaration(manifestPath, '@module-federation/vite'),
      }).toEqual({ manifestPath, federation: '^1.20.8' });
    }

    expect(trackedManifestsDeclaring('vite-plugin-dts')).toEqual([...DTS_CONSUMERS].sort());
    for (const manifestPath of DTS_CONSUMERS) {
      expect({ manifestPath, dts: declaration(manifestPath, 'vite-plugin-dts') }).toEqual({
        manifestPath,
        dts: '^4.5.4',
      });
    }

    const lock = readJson<Lockfile>('package-lock.json');
    const root = readJson<PackageManifest>('package.json');
    expect(root.overrides?.['vite-plugin-dts']).toEqual({
      '@microsoft/api-extractor': API_EXTRACTOR_VERSION,
    });
    expect(root.overrides?.['@microsoft/api-extractor']).toBeUndefined();
    expect(root.overrides?.diff).toBe('8.0.3');
    expect(root.overrides?.['ts-node']).toEqual({ diff: '4.0.4' });
    expect(resolvedVersions(lock, '@microsoft/api-extractor')).toEqual([API_EXTRACTOR_VERSION]);
    expect(lock.packages?.['node_modules/diff']?.version).toBe('4.0.4');
    expect(
      lock.packages?.['node_modules/@microsoft/api-extractor/node_modules/diff']?.version,
    ).toBe('8.0.3');
    expect(lock.packages?.['node_modules/ts-node/node_modules/diff']).toBeUndefined();
    for (const dependency of ['@module-federation/vite', 'vite-plugin-dts']) {
      const floor = dependency === '@module-federation/vite' ? '1.20.8' : '4.5.4';
      const versions = resolvedVersions(lock, dependency);
      expect({ dependency, hasResolution: versions.length > 0 }).toEqual({
        dependency,
        hasResolution: true,
      });
      for (const version of versions) {
        expect({ dependency, version, safe: comparable(version) >= comparable(floor) }).toEqual({
          dependency,
          version,
          safe: true,
        });
      }
    }
    const federationDtsResolutions = Object.entries(lock.packages ?? {})
      .filter(([path]) => /(?:^|node_modules\/)@module-federation\/dts-plugin$/.test(path))
      .map(([path, entry]) => ({ path, version: entry.version }));
    expect(federationDtsResolutions.length).toBeGreaterThan(0);
    for (const { path, version } of federationDtsResolutions) {
      expect({ path, hasVersion: version !== undefined }).toEqual({ path, hasVersion: true });
      expect({ path, safe: comparable(version as string) >= comparable('2.8.2') }).toEqual({
        path,
        safe: true,
      });
    }
  });

  test('keeps AquaMobil standalone production and build transitive packages above safe floors', () => {
    const manifest = readJson<PackageManifest>('web/apps/aquamobil/package.json');
    const lock = readJson<Lockfile>('web/apps/aquamobil/package-lock.json');

    expect(manifest.devDependencies?.postcss).toBe('^8.5.23');
    expect(manifest.overrides).toEqual({
      ...(manifest.overrides ?? {}),
      'socket.io-parser': '4.2.7',
      // 3.1.6 clears GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf
      // and GHSA-jqff-g426-hqxp; the previous floor had itself become vulnerable.
      'fast-uri': '3.1.6',
      // 4.28.9 clears the unbounded cache growth and the prototype write.
      browserslist: '4.28.9',
      nanoid: '3.3.18',
      protobufjs: '7.6.5',
      esbuild: '^0.28.1',
    });
    expect(resolvedVersions(lock, 'socket.io-parser')).toEqual(['4.2.7']);
    expect(resolvedVersions(lock, 'protobufjs')).toEqual(['7.6.5']);
    expect(resolvedVersions(lock, 'fast-uri')).toEqual(['3.1.6']);
    expect(resolvedVersions(lock, 'browserslist')).toEqual(['4.28.9']);
    expect(resolvedVersions(lock, 'nanoid')).toEqual(['3.3.18']);
    const esbuildVersions = resolvedVersions(lock, 'esbuild');
    expect(esbuildVersions.length).toBeGreaterThan(0);
    for (const version of esbuildVersions) {
      expect({ version, safe: comparable(version) >= comparable('0.28.1') }).toEqual({
        version,
        safe: true,
      });
    }
    const postcssVersions = resolvedVersions(lock, 'postcss');
    expect(postcssVersions.length).toBeGreaterThan(0);
    for (const version of postcssVersions) {
      expect({ version, safe: comparable(version) >= comparable('8.5.23') }).toEqual({
        version,
        safe: true,
      });
    }
    expect(resolvedVersions(lock, 'brace-expansion')).toEqual(['2.1.4', '5.0.9']);
  });

  test('keeps the standalone E2E graph above its patched CI supply-chain floors', () => {
    const manifest = readJson<PackageManifest>('e2e/package.json');
    const lock = readJson<Lockfile>('e2e/package-lock.json');

    const jsYamlDeclaration = manifest.devDependencies?.['js-yaml'];
    expect(jsYamlDeclaration).toBeDefined();
    expect({
      dependency: 'js-yaml',
      safe: comparable((jsYamlDeclaration as string).replace(/^[~^]/, '')) >= comparable('4.3.1'),
    }).toEqual({ dependency: 'js-yaml', safe: true });

    const jsYamlFloorsByMajor: Readonly<Record<string, string>> = {
      '3': '3.15.1',
      '4': '4.3.1',
      // Major 5 succeeds the patched 4.3.1 line; the floor is the first
      // adopted 5.x (this PR's bump). Older 5.x are unvetted — keep them out.
      '5': '5.4.0',
    };
    const jsYamlVersions = resolvedVersions(lock, 'js-yaml');
    expect(jsYamlVersions.length).toBeGreaterThan(0);
    for (const version of jsYamlVersions) {
      const floor = jsYamlFloorsByMajor[version.split('.')[0] ?? ''];
      expect({
        dependency: 'js-yaml',
        version,
        safe: floor !== undefined && comparable(version) >= comparable(floor),
      }).toEqual({ dependency: 'js-yaml', version, safe: true });
    }

    for (const [dependency, floor] of Object.entries(E2E_SECURITY_FLOORS)) {
      const versions = resolvedVersions(lock, dependency);
      expect({ dependency, hasResolution: versions.length > 0 }).toEqual({
        dependency,
        hasResolution: true,
      });
      for (const version of versions) {
        expect({ dependency, version, safe: comparable(version) >= comparable(floor) }).toEqual({
          dependency,
          version,
          safe: true,
        });
      }
    }
  });

  test('keeps E2E-only changes inside CI without granting deploy authority', () => {
    const workflow = YAML.parse(readRepoFile('.github/workflows/ci-affected.yml')) as Workflow;
    const detect = workflow.jobs?.['detect-changes'];
    const scope = detect?.steps?.find((step) => step.id === 'scope')?.run ?? '';
    const selected = JSON.parse(
      execFileSync(
        process.execPath,
        [
          resolve(REPO_ROOT, 'scripts/ci/select-deployment-scope.ts'),
          '--repo',
          REPO_ROOT,
          '--requested-services',
          'auto',
          '--channel',
          'development',
          '--changed-files-json',
          JSON.stringify(['e2e/package-lock.json']),
          '--affected-projects-json',
          '[]',
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      ),
    ) as {
      dependencyAuditRequired: boolean;
      deployServices: string[];
    };

    expect(selected).toEqual(
      expect.objectContaining({
        dependencyAuditRequired: true,
        deployServices: [],
      }),
    );
    expect(detect?.outputs).toMatchObject({
      has_changes: '${{ steps.check.outputs.has_changes }}',
      deploy_changes: '${{ steps.check.outputs.deploy_changes }}',
      dependency_audit_required: '${{ steps.scope.outputs.dependency_audit_required }}',
    });
    expect(scope).toContain('scripts/ci/select-deployment-scope.ts');
    expect(detect?.steps?.some((step) => step.id === 'changes')).toBe(false);
    expect(workflow.jobs?.['build-development-images']?.if).toContain(
      "needs.detect-changes.outputs.deploy_changes == 'true'",
    );
    expect(workflow.jobs?.['security-audit']?.if).toContain(
      "needs.detect-changes.outputs.dependency_audit_required == 'true'",
    );
  });

  test.each(['.github/workflows/ci-affected.yml', '.github/workflows/ci-full.yml'])(
    '%s validates every standalone npm lock before using it as audit evidence',
    (workflowPath) => {
      const workflow = YAML.parse(readRepoFile(workflowPath)) as Workflow;
      const steps =
        workflow.jobs?.['security-audit']?.steps ?? workflow.jobs?.['security-scan']?.steps ?? [];
      const standaloneLockCheck = steps.find(
        (step) => step.name === 'Validate standalone npm locks',
      );

      expect(standaloneLockCheck?.run?.trim().split(/\r?\n/)).toEqual([
        'npm --prefix web/apps/aquamobil ci --package-lock-only --ignore-scripts --no-audit --no-fund',
        'npm --prefix e2e ci --package-lock-only --ignore-scripts --no-audit --no-fund',
      ]);
    },
  );

  test.each(['.github/workflows/ci-affected.yml', '.github/workflows/ci-full.yml'])(
    '%s audits production and full dependency graphs without losing either failure',
    (workflowPath) => {
      const workflow = YAML.parse(readRepoFile(workflowPath)) as Workflow;
      const steps =
        workflow.jobs?.['security-audit']?.steps ?? workflow.jobs?.['security-scan']?.steps ?? [];
      const audit = steps.find((step) => step.run?.includes('npm audit'))?.run ?? '';
      const upload = steps.find((step) =>
        step.with?.path?.toString().includes('npm-audit-root-production.json'),
      );
      const auditGraphs = [
        {
          command:
            'npm audit --audit-level=moderate --omit=dev --json > npm-audit-root-production.json',
          json: 'npm-audit-root-production.json',
          markdown: 'npm-audit-root-production.md',
          status: 'ROOT_PRODUCTION',
          level: 'moderate',
          scope: 'root-production',
        },
        {
          command: 'npm audit --audit-level=high --json > npm-audit-root-full.json',
          json: 'npm-audit-root-full.json',
          markdown: 'npm-audit-root-full.md',
          status: 'ROOT_FULL',
          level: 'high',
          scope: 'root-full',
        },
        {
          command:
            'npm --prefix web/apps/aquamobil audit --audit-level=moderate --omit=dev --json > npm-audit-aquamobil-production.json',
          json: 'npm-audit-aquamobil-production.json',
          markdown: 'npm-audit-aquamobil-production.md',
          status: 'AQUAMOBIL_PRODUCTION',
          level: 'moderate',
          scope: 'aquamobil-production',
        },
        {
          command:
            'npm --prefix web/apps/aquamobil audit --audit-level=high --json > npm-audit-aquamobil-full.json',
          json: 'npm-audit-aquamobil-full.json',
          markdown: 'npm-audit-aquamobil-full.md',
          status: 'AQUAMOBIL_FULL',
          level: 'high',
          scope: 'aquamobil-full',
        },
        {
          command:
            'npm --prefix e2e audit --audit-level=moderate --omit=dev --json > npm-audit-e2e-production.json',
          json: 'npm-audit-e2e-production.json',
          markdown: 'npm-audit-e2e-production.md',
          status: 'E2E_PRODUCTION',
          level: 'moderate',
          scope: 'e2e-production',
        },
        {
          command: 'npm --prefix e2e audit --audit-level=high --json > npm-audit-e2e-full.json',
          json: 'npm-audit-e2e-full.json',
          markdown: 'npm-audit-e2e-full.md',
          status: 'E2E_FULL',
          level: 'high',
          scope: 'e2e-full',
        },
      ] as const;

      const gate =
        steps.find((step) => step.run?.includes('scripts/ci/npm-audit-gate.mjs'))?.run ?? '';
      const artifactPaths = upload?.with?.path?.toString() ?? '';
      expect(auditScriptSatisfiesContract(audit, auditGraphs)).toBe(true);
      // Every graph the step produces is also judged, at its own level and scope.
      expect(gateStepCovers(gate, auditGraphs)).toEqual([]);
      for (const graph of auditGraphs) {
        expect(artifactPaths).toContain(graph.json);
        expect(artifactPaths).toContain(graph.markdown);
      }
      expect(upload?.if).toBe('always()');
      expect(upload?.with?.['if-no-files-found']).toBe('error');
    },
  );

  test('migration immutability installs dev tooling with lifecycle and funding disabled', () => {
    const workflow = YAML.parse(
      readRepoFile('.github/workflows/db-migration-check.yml'),
    ) as Workflow;
    const install = workflow.jobs?.['migration-immutability-witness']?.steps?.find(
      (step) => step.name === 'Install dependencies',
    )?.run;

    expect(install).toContain('npm ci');
    expect(install).toContain('--ignore-scripts');
    expect(install).toContain('--no-fund');
    expect(install).not.toContain('--omit=dev');
  });
});
